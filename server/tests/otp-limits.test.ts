import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { AuthSession, Booking, PaymentIntent } from "../../shared/types.js";
import { setupTestApp, teardownTestApp } from "./setup.js";

let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-otp-");
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

interface ScreeningResponse {
  screenings: Array<{ days: Array<{ times: Array<{ showtimeId: string }> }> }>;
}

interface SeatsResponse {
  seats: Array<{ id: string; status: string }>;
}

async function signUp(email: string): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "OTP Tester", email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
  expect(res.status).toBe(201);
  return res.body as AuthSession;
}

async function encryptedCard() {
  const { getPaymentKeyPair, encryptLikeBrowser } = await import("../src/services/cryptoService.js");
  const { keyId, publicKey } = getPaymentKeyPair();
  return {
    keyId,
    encrypted: encryptLikeBrowser(
      JSON.stringify({ number: "4242424242424242", name: "OTP Tester", expiry: "12/30", cvc: "123" }),
      publicKey,
    ),
  };
}

/** Registers a user, books one seat and opens a payment intent. */
async function openIntent(tag: string, phone: string): Promise<{ auth: string; payment: PaymentIntent }> {
  const session = await signUp(`${tag}@example.com`);
  const auth = `Bearer ${session.accessToken}`;
  const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
  const showtimeId = screening.screenings[0]!.days[0]!.times[0]!.showtimeId;
  const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatsResponse;
  const seatId = seats.seats.find((seat) => seat.status === "available")!.id;

  const bookingRes = await request(app)
    .post("/api/bookings")
    .set("Authorization", auth)
    .send({ showtimeId, seatIds: [seatId] });
  expect(bookingRes.status).toBe(201);
  const bookingId = (bookingRes.body as { booking: Booking }).booking.id;

  const intentRes = await request(app)
    .post("/api/payments/intents")
    .set("Authorization", auth)
    .send({ bookingId, method: "card", phone, card: await encryptedCard() });
  expect(intentRes.status, JSON.stringify(intentRes.body)).toBe(201);
  return { auth, payment: (intentRes.body as { payment: PaymentIntent }).payment };
}

describe("OTP rules (ТЗ: 6 digits, 5-minute TTL, 3 attempts, 5 SMS/hour)", () => {
  it("issues 6-digit codes with a 5-minute TTL", async () => {
    const { payment } = await openIntent("otp-shape", "+15550000001");
    expect(payment.codeLength).toBe(6);
    expect(payment.devCode).toMatch(/^\d{6}$/);
    expect(payment.attemptsLeft).toBe(3);
    const ttlMs = new Date(payment.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(290_000);
    expect(ttlMs).toBeLessThanOrEqual(300_000);
  });

  it("fails the intent after 3 wrong attempts", async () => {
    const { auth, payment } = await openIntent("otp-attempts", "+15550000002");

    for (const left of [2, 1]) {
      const res = await request(app)
        .post(`/api/payments/${payment.id}/verify`)
        .set("Authorization", auth)
        .send({ code: "000000" });
      expect(res.status).toBe(402);
      expect((res.body.error.details as { payment: PaymentIntent }).payment.attemptsLeft).toBe(left);
    }

    const terminal = await request(app)
      .post(`/api/payments/${payment.id}/verify`)
      .set("Authorization", auth)
      .send({ code: "000000" });
    expect(terminal.status).toBe(402);
    expect(terminal.body.error.message).toMatch(/Too many incorrect codes/);

    // Even the correct code is dead now.
    const late = await request(app)
      .post(`/api/payments/${payment.id}/verify`)
      .set("Authorization", auth)
      .send({ code: payment.devCode! });
    expect(late.status).toBe(402);
  });

  it("resends supersede the old code and restore attempts", async () => {
    const { auth, payment } = await openIntent("otp-resend", "+15550000003");

    const wrong = await request(app)
      .post(`/api/payments/${payment.id}/verify`)
      .set("Authorization", auth)
      .send({ code: "000000" });
    expect((wrong.body.error.details as { payment: PaymentIntent }).payment.attemptsLeft).toBe(2);

    const resend = async () => {
      const res = await request(app).post(`/api/payments/${payment.id}/resend`).set("Authorization", auth);
      expect(res.status).toBe(200);
      return (res.body as { payment: PaymentIntent }).payment;
    };
    let fresh = await resend();
    // A random collision would make the "stale" check below meaningless.
    if (fresh.devCode === payment.devCode) fresh = await resend();
    expect(fresh.attemptsLeft).toBe(3);
    expect(fresh.devCode).toMatch(/^\d{6}$/);

    // The superseded code counts as a wrong attempt against the new one.
    const stale = await request(app)
      .post(`/api/payments/${payment.id}/verify`)
      .set("Authorization", auth)
      .send({ code: payment.devCode! });
    expect(stale.status).toBe(402);
    expect((stale.body.error.details as { payment: PaymentIntent }).payment.attemptsLeft).toBe(2);

    const good = await request(app)
      .post(`/api/payments/${payment.id}/verify`)
      .set("Authorization", auth)
      .send({ code: fresh.devCode! });
    expect(good.status).toBe(200);
  });

  it("caps SMS at 5 per hour per phone number", async () => {
    const { auth, payment } = await openIntent("otp-quota", "+15550000004");

    // 1 (intent) + 4 resends = the hourly budget.
    for (let i = 0; i < 4; i += 1) {
      const resend = await request(app).post(`/api/payments/${payment.id}/resend`).set("Authorization", auth);
      expect(resend.status, `resend ${i + 1}`).toBe(200);
    }

    const capped = await request(app).post(`/api/payments/${payment.id}/resend`).set("Authorization", auth);
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("rate_limited");
    expect(capped.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rate limiter denies past the max in both backends", async () => {
    const { createRateLimiter } = await import("../src/redis/rateLimit.js");
    const limiter = createRateLimiter({ prefix: "sms:rl", max: 2, windowSeconds: 60 });
    expect((await limiter.check("limiter-probe")).allowed).toBe(true);
    expect((await limiter.check("limiter-probe")).allowed).toBe(true);
    const denied = await limiter.check("limiter-probe");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });
});
