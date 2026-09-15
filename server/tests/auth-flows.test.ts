import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestApp, teardownTestApp } from "./setup.js";
import type { AuthSession, Booking, SeatMap, User } from "../../shared/types.js";

/**
 * ТЗ §5: гостевой checkout + SMS-верификация; §6: magic link.
 * The three flows share one app instance; each test uses its own seats so the
 * files stay independent of execution order.
 */

let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-auth-flows-");
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

async function freeSeats(count: number): Promise<{ showtimeId: string; seatIds: string[] }> {
  const showtimes = await request(app).get("/api/showtimes").expect(200);
  const items = showtimes.body.items as Array<{ id: string }>;
  for (const showtime of items.slice(0, 12)) {
    const seats = (await request(app).get(`/api/showtimes/${showtime.id}/seats`).expect(200)).body as SeatMap;
    const free = seats.seats.filter((seat) => seat.status === "available").slice(0, count);
    if (free.length === count) return { showtimeId: showtime.id, seatIds: free.map((seat) => seat.id) };
  }
  throw new Error("no showtime with enough free seats");
}

describe("guest checkout", () => {
  it("books without an account and returns a token scoped to the booking", async () => {
    const { showtimeId, seatIds } = await freeSeats(2);
    const res = await request(app)
      .post("/api/auth/guest")
      .send({ name: "Guest Buyer", email: "guest.buyer@example.com", showtimeId, seatIds });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { booking, guest, user } = res.body as {
      booking: Booking;
      guest: { token: string; expiresAt: number };
      user: User;
    };
    expect(booking.status).toBe("pending");
    expect(booking.seats).toHaveLength(2);
    expect(guest.token).toBeTruthy();
    expect(guest.expiresAt).toBeGreaterThan(Date.now());
    expect(user.email).toBe("guest.buyer@example.com");

    // The token is a real access token: the guest sees exactly their booking.
    const mine = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set("Authorization", `Bearer ${guest.token}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect((mine.body as { booking: Booking }).booking.id).toBe(booking.id);

    // …and nobody else's.
    const other = await request(app).get("/api/bookings/does-not-exist").set("x-auth-token", guest.token);
    expect(other.status).toBe(404);
  });

  it("refuses a full account instead of silently taking it over", async () => {
    const registered = await request(app).post("/api/auth/register").send({
      name: "Has Account",
      email: "has.account@example.com",
      password: "Str0ngPassw0rd",
      confirmPassword: "Str0ngPassw0rd",
    });
    expect(registered.status).toBe(201);

    const { showtimeId, seatIds } = await freeSeats(1);
    const res = await request(app)
      .post("/api/auth/guest")
      .send({ name: "Has Account", email: "has.account@example.com", showtimeId, seatIds });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("claims the guest account with a password and keeps the tickets", async () => {
    const { showtimeId, seatIds } = await freeSeats(1);
    const created = await request(app)
      .post("/api/auth/guest")
      .send({ name: "Claim Me", email: "claim.me@example.com", showtimeId, seatIds });
    expect(created.status).toBe(201);
    const { booking, guest } = created.body as { booking: Booking; guest: { token: string } };

    const claim = await request(app)
      .post("/api/auth/guest/claim")
      .send({ guestToken: guest.token, password: "Str0ngPassw0rd" });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    const session = claim.body as AuthSession;

    // Same user row → the booking is still there, and the password works.
    const mine = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(mine.status).toBe(200);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "claim.me@example.com", password: "Str0ngPassw0rd" });
    expect(login.status).toBe(200);

    // A second claim is refused (the account is no longer a guest).
    const again = await request(app)
      .post("/api/auth/guest/claim")
      .send({ guestToken: guest.token, password: "Str0ngPassw0rd" });
    expect(again.status).toBe(409);
  });

  it("rejects a forged guest token", async () => {
    const res = await request(app)
      .post("/api/auth/guest/claim")
      .send({ guestToken: "not.a.real.token.value", password: "Str0ngPassw0rd" });
    expect(res.status).toBe(401);
  });
});

describe("magic link", () => {
  it("signs in with a single-use link", async () => {
    await request(app).post("/api/auth/register").send({
      name: "Magic User",
      email: "magic.user@example.com",
      password: "Str0ngPassw0rd",
      confirmPassword: "Str0ngPassw0rd",
    });

    const requested = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "magic.user@example.com" });
    expect(requested.status).toBe(202);
    const token = requested.body.devToken as string;
    expect(token).toBeTruthy();

    const verified = await request(app).post("/api/auth/magic-link/verify").send({ token });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    const session = verified.body as AuthSession;
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${session.accessToken}`);
    expect(me.status).toBe(200);
    expect((me.body as { user: User }).user.email).toBe("magic.user@example.com");

    // Single use: the same link cannot be replayed.
    const replay = await request(app).post("/api/auth/magic-link/verify").send({ token });
    expect(replay.status).toBe(401);
  });

  it("does not reveal whether an address has an account", async () => {
    const unknown = await request(app).post("/api/auth/magic-link").send({ email: "nobody@example.com" });
    expect(unknown.status).toBe(202);
    expect(unknown.body.requested).toBe(true);
    expect(unknown.body.devToken).toBeUndefined();
  });

  it("rejects a tampered token", async () => {
    await request(app).post("/api/auth/register").send({
      name: "Tamper",
      email: "tamper@example.com",
      password: "Str0ngPassw0rd",
      confirmPassword: "Str0ngPassw0rd",
    });
    const requested = await request(app).post("/api/auth/magic-link").send({ email: "tamper@example.com" });
    const token = requested.body.devToken as string;
    const tampered = `${token.slice(0, -3)}abc`;
    const res = await request(app).post("/api/auth/magic-link/verify").send({ token: tampered });
    expect(res.status).toBe(401);
  });
});

describe("phone verification", () => {
  it("verifies a phone number with the SMS code and stores it on the user", async () => {
    const session = (
      await request(app).post("/api/auth/register").send({
        name: "Phone User",
        email: "phone.user@example.com",
        password: "Str0ngPassw0rd",
        confirmPassword: "Str0ngPassw0rd",
      })
    ).body as AuthSession;

    const requested = await request(app)
      .post("/api/auth/phone/verify")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({ phone: "+12025550999" });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const code = requested.body.devCode as string;
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await request(app)
      .post("/api/auth/phone/confirm")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({ code: "000000" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const confirmed = await request(app)
      .post("/api/auth/phone/confirm")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({ code, phone: "+12025550999" });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((confirmed.body as { user: User }).user.phone).toBe("+12025550999");
    expect((confirmed.body as { user: { phoneVerifiedAt?: string } }).user.phoneVerifiedAt).toBeTruthy();

    // The verified number survives a fresh profile read.
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${session.accessToken}`);
    expect((me.body as { user: User }).user.phone).toBe("+12025550999");
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/auth/phone/verify").send({ phone: "+12025550998" });
    expect(res.status).toBe(401);
  });
});
