import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestApp, teardownTestApp } from "./setup.js";
import type { AuthSession, Booking, PaymentIntent, SeatMap } from "../../shared/types.js";

let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-security-");
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

const TEST_CARD = { number: "4242 4242 4242 4242", name: "Ada Lovelace", expiry: "12/30", cvc: "123" };

interface ScreeningResponse {
  screenings: Array<{
    days: Array<{ date: string; times: Array<{ showtimeId: string; time: string; seatsLeft: number }> }>;
  }>;
}

interface ExportBody {
  user: Record<string, unknown>;
  bookings: Booking[];
  payments: Array<Record<string, unknown>>;
  audit: Array<{ action: string }>;
  exportedAt: string;
}

async function signUp(email: string, name = "Test User"): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name, email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as AuthSession;
}

/** Encrypts the card exactly the way the browser does (RSA-OAEP + SHA-256). */
async function encryptedCard(card: typeof TEST_CARD) {
  const { getPaymentKeyPair, encryptLikeBrowser } = await import("../src/services/cryptoService.js");
  const { keyId, publicKey } = getPaymentKeyPair();
  return { keyId, encrypted: encryptLikeBrowser(JSON.stringify(card), publicKey) };
}

async function bookSeats(email: string): Promise<{ session: AuthSession; auth: string; booking: Booking }> {
  const session = await signUp(email);
  const auth = `Bearer ${session.accessToken}`;

  const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
  const lastDay = screening.screenings[0]!.days.at(-1)!;
  const showtimeId = lastDay.times[0]!.showtimeId;

  const seatMap = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatMap;
  const free = seatMap.seats.filter((seat) => seat.status === "available").slice(0, 2);
  expect(free).toHaveLength(2);

  const hold = await request(app)
    .post(`/api/showtimes/${showtimeId}/holds`)
    .send({ seatIds: free.map((seat) => seat.id) });
  expect(hold.status).toBe(200);
  const holdToken = (hold.body as { holdToken: string }).holdToken;

  const bookingRes = await request(app)
    .post("/api/bookings")
    .set("Authorization", auth)
    .send({ showtimeId, seatIds: free.map((seat) => seat.id), holdToken });
  expect(bookingRes.status, JSON.stringify(bookingRes.body)).toBe(201);
  return { session, auth, booking: (bookingRes.body as { booking: Booking }).booking };
}

async function payFor(
  auth: string,
  booking: Booking,
  phone: string,
): Promise<{ paid: Booking; intent: PaymentIntent }> {
  const intentRes = await request(app)
    .post("/api/payments/intents")
    .set("Authorization", auth)
    .send({ bookingId: booking.id, method: "card", phone, card: await encryptedCard(TEST_CARD) });
  expect(intentRes.status, JSON.stringify(intentRes.body)).toBe(201);
  const intent = (intentRes.body as { payment: PaymentIntent }).payment;

  const goodCode = await request(app)
    .post(`/api/payments/${intent.id}/verify`)
    .set("Authorization", auth)
    .send({ code: intent.devCode! });
  expect(goodCode.status, JSON.stringify(goodCode.body)).toBe(200);
  const paid = (goodCode.body as { booking: Booking }).booking;
  expect(paid.status).toBe("confirmed");
  return { paid, intent };
}

describe("GET /api/auth/export", () => {
  it("exports the profile, bookings, masked payments and audit trail", async () => {
    const { auth } = await bookSeats("export@example.com").then(async (booked) => {
      await payFor(booked.auth, booked.booking, "+12025550131");
      return booked;
    });

    const res = await request(app).get("/api/auth/export").set("Authorization", auth);
    expect(res.status).toBe(200);
    const body = res.body as ExportBody;
    expect(body.user).toMatchObject({ name: "Test User", email: "export@example.com" });
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]!.status).toBe("confirmed");
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ status: "succeeded", cardLast4: "4242" });
    expect(body.payments[0]).not.toHaveProperty("phone");
    expect(body.payments[0]!.phoneMasked).toMatch(/\+1/);
    expect(body.audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["auth.register", "payment.succeeded"]),
    );
    expect(body.exportedAt).toBeTruthy();
  }, 30_000);

  it("requires authentication", async () => {
    const res = await request(app).get("/api/auth/export");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/auth/account", () => {
  it("erases the user, frees their seats and revokes the session", async () => {
    const booked = await bookSeats("erase@example.com");
    const { paid } = await payFor(booked.auth, booked.booking, "+12025550132");
    const { session, auth } = booked;

    const res = await request(app).delete("/api/auth/account").set("Authorization", auth);
    expect(res.status).toBe(204);
    // The mirrored session cookie is cleared alongside.
    expect(JSON.stringify(res.headers["set-cookie"] ?? "")).toContain("ct_session=");

    // The profile is gone (the short-lived access token itself expires in 15m).
    const me = await request(app).get("/api/auth/me").set("Authorization", auth);
    expect(me.status).toBe(404);

    // The refresh token cannot renew the session.
    const refresh = await request(app).post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(refresh.status).not.toBe(200);

    // The email is free and the seats are back on sale.
    const again = await signUp("erase@example.com", "Second Life");
    expect(again.user.email).toBe("erase@example.com");

    const seats = (await request(app).get(`/api/showtimes/${paid.showtimeId}/seats`)).body as SeatMap;
    const statuses = new Map(seats.seats.map((seat) => [seat.id, seat.status]));
    for (const seat of paid.seats) expect(statuses.get(seat.seatId)).not.toBe("sold");
  }, 30_000);

  it("requires authentication", async () => {
    const res = await request(app).delete("/api/auth/account");
    expect(res.status).toBe(401);
  });
});

describe("audit trail", () => {
  it("records register, login, payment and refund", async () => {
    const { getRepositories } = await import("../src/db/provider.js");
    const booked = await bookSeats("audit@example.com");
    await request(app)
      .post("/api/auth/login")
      .send({ email: "audit@example.com", password: "Str0ngPassw0rd" })
      .expect(200);
    const { paid } = await payFor(booked.auth, booked.booking, "+12025550133");
    await request(app).post(`/api/bookings/${paid.id}/refund`).set("Authorization", booked.auth).expect(200);

    const trail = await getRepositories().audit.listByUser(booked.session.user.id);
    expect(trail.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["auth.register", "auth.login", "payment.succeeded", "booking.refunded"]),
    );
    // Nothing but ids and amounts — the trail survives GDPR erasure lawfully.
    for (const entry of trail) {
      expect(JSON.stringify(entry.meta ?? {})).not.toMatch(/audit@example\.com|\+1202/);
    }
  }, 30_000);

  it("records failed payments", async () => {
    const { getRepositories } = await import("../src/db/provider.js");
    const booked = await bookSeats("audit-fail@example.com");
    const intentRes = await request(app)
      .post("/api/payments/intents")
      .set("Authorization", booked.auth)
      .send({
        bookingId: booked.booking.id,
        method: "card",
        phone: "+12025550134",
        card: await encryptedCard(TEST_CARD),
      });
    expect(intentRes.status).toBe(201);
    const intent = (intentRes.body as { payment: PaymentIntent }).payment;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app)
        .post(`/api/payments/${intent.id}/verify`)
        .set("Authorization", booked.auth)
        .send({ code: "000000" });
    }
    const trail = await getRepositories().audit.listByUser(booked.session.user.id);
    expect(trail.map((entry) => entry.action)).toContain("payment.failed");
  }, 30_000);
});

describe("cookie CSRF guard", () => {
  it("sets a Lax, HttpOnly session cookie", async () => {
    const res = await request(app).post("/api/auth/register").send({
      name: "Cookie",
      email: "cookie-flags@example.com",
      password: "Str0ngPassw0rd",
      confirmPassword: "Str0ngPassw0rd",
    });
    expect(res.status).toBe(201);
    const cookies = (res.headers["set-cookie"] ?? []) as string[];
    const session = cookies.find((cookie) => cookie.startsWith("ct_session="));
    expect(session).toBeTruthy();
    expect(session!).toMatch(/httponly/i);
    expect(session!).toMatch(/samesite=lax/i);
  });

  it("rejects cookie-authenticated mutations without X-Requested-With", async () => {
    const res = await request(app).post("/api/auth/register").send({
      name: "Cookie",
      email: "csrf@example.com",
      password: "Str0ngPassw0rd",
      confirmPassword: "Str0ngPassw0rd",
    });
    expect(res.status).toBe(201);
    const cookies = (res.headers["set-cookie"] ?? []) as string[];
    const session = cookies.find((cookie) => cookie.startsWith("ct_session="))!.split(";")[0]!;

    const blocked = await request(app).post("/api/bookings/bk_nope/receipt").set("Cookie", session);
    expect(blocked.status).toBe(403);

    // The same request with the header reaches the handler (404: no such booking).
    const passed = await request(app)
      .post("/api/bookings/bk_nope/receipt")
      .set("Cookie", session)
      .set("X-Requested-With", "XMLHttpRequest");
    expect(passed.status).toBe(404);
  });
});
