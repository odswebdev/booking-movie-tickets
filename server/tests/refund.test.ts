import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestApp, teardownTestApp } from "./setup.js";
import type { EmailMessage } from "../src/services/email/types.js";
import type { AuthSession, Booking, PaymentIntent, SeatMap } from "../../shared/types.js";

let app: Express;
let tempDir: string;
let drainEmailOutbox: () => EmailMessage[];

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-refund-");
  app = ctx.app;
  tempDir = ctx.tempDir;
  // Dynamic: static src imports would parse `env` (and DATA_DIR) too early.
  ({ drainEmailOutbox } = await import("../src/services/email/mock.js"));
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

const TEST_CARD = { number: "4242 4242 4242 4242", name: "Ada Lovelace", expiry: "12/30", cvc: "123" };
const TEST_PHONE = "+12025550123";

interface ScreeningResponse {
  screenings: Array<{
    days: Array<{ date: string; times: Array<{ showtimeId: string; time: string; seatsLeft: number }> }>;
  }>;
}

async function signUp(email: string, name = "Test User"): Promise<AuthSession> {
  const res = await request(app).post("/api/auth/register").send({
    name,
    email,
    password: "Str0ngPassw0rd",
    confirmPassword: "Str0ngPassw0rd",
  });
  expect(res.status).toBe(201);
  return res.body as AuthSession;
}

/** Encrypts the card exactly the way the browser does (RSA-OAEP + SHA-256). */
async function encryptedCard(card: typeof TEST_CARD) {
  const { getPaymentKeyPair, encryptLikeBrowser } = await import("../src/services/cryptoService.js");
  const { keyId, publicKey } = getPaymentKeyPair();
  return { keyId, encrypted: encryptLikeBrowser(JSON.stringify(card), publicKey) };
}

/** Holds and books the first two free seats of a comfortably future showtime. */
async function bookSeats(email: string): Promise<{ session: AuthSession; auth: string; booking: Booking }> {
  const session = await signUp(email);
  const auth = `Bearer ${session.accessToken}`;

  const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
  // Pick the furthest date so the cancellation window is comfortably open.
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

async function paidBooking(email: string, phone: string = TEST_PHONE) {
  const booked = await bookSeats(email);
  const { paid, intent } = await payFor(booked.auth, booked.booking, phone);
  return { ...booked, booking: paid, intent };
}

async function paymentStatus(auth: string, paymentId: string): Promise<string> {
  const res = await request(app).get(`/api/payments/${paymentId}`).set("Authorization", auth);
  expect(res.status).toBe(200);
  return (res.body as { payment: PaymentIntent }).payment.status;
}

describe("POST /api/bookings/:id/refund", () => {
  it("reverses the charge, releases seats and emails the visitor", async () => {
    const { auth, booking, intent } = await paidBooking("refund-ok@example.com", "+12025550121");
    drainEmailOutbox(); // the ticket confirmation from paying

    const res = await request(app).post(`/api/bookings/${booking.id}/refund`).set("Authorization", auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { booking: Booking; refunded: boolean };
    expect(body.refunded).toBe(true);
    expect(body.booking.status).toBe("cancelled");

    expect(await paymentStatus(auth, intent.id)).toBe("refunded");

    const seats = (await request(app).get(`/api/showtimes/${booking.showtimeId}/seats`)).body as SeatMap;
    const statuses = new Map(seats.seats.map((seat) => [seat.id, seat.status]));
    for (const seat of booking.seats) expect(statuses.get(seat.seatId)).not.toBe("sold");

    const outbox = drainEmailOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toContain("Refund");
    expect(outbox[0]!.subject).toContain(booking.code);
  }, 30_000);

  it("rejects a second refund with 409", async () => {
    const { auth, booking } = await paidBooking("refund-twice@example.com", "+12025550122");

    const first = await request(app).post(`/api/bookings/${booking.id}/refund`).set("Authorization", auth);
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/bookings/${booking.id}/refund`).set("Authorization", auth);
    expect(second.status).toBe(409);
  }, 30_000);

  it("rejects refunding an unpaid booking with 409", async () => {
    const { auth, booking } = await bookSeats("refund-pending@example.com");
    expect(booking.status).toBe("pending");

    const res = await request(app).post(`/api/bookings/${booking.id}/refund`).set("Authorization", auth);
    expect(res.status).toBe(409);
  }, 30_000);

  it("404s unknown bookings and other visitors' tickets", async () => {
    const { booking } = await paidBooking("refund-owner@example.com", "+12025550123");
    const stranger = await signUp("refund-stranger@example.com", "Stranger");
    const strangerAuth = `Bearer ${stranger.accessToken}`;

    const foreign = await request(app)
      .post(`/api/bookings/${booking.id}/refund`)
      .set("Authorization", strangerAuth);
    expect(foreign.status).toBe(404);

    const missing = await request(app)
      .post("/api/bookings/bk_nope/refund")
      .set("Authorization", strangerAuth);
    expect(missing.status).toBe(404);
  }, 30_000);

  it("cancels without a charge when no succeeded payment is on file", async () => {
    const { auth, booking, intent } = await paidBooking("refund-nocharge@example.com", "+12025550124");
    // Simulate a charge the PSP can't reverse (data fixed by support later).
    const { getRepositories } = await import("../src/db/provider.js");
    await getRepositories().payments.update(intent.id, { providerRef: null });

    const res = await request(app).post(`/api/bookings/${booking.id}/refund`).set("Authorization", auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { booking: Booking; refunded: boolean };
    expect(body.refunded).toBe(false);
    expect(body.booking.status).toBe("cancelled");
  }, 30_000);

  it("rejects late refunds and keeps the ticket valid", async () => {
    const { auth, booking } = await paidBooking("refund-late@example.com", "+12025550125");
    const { refundBooking } = await import("../src/services/bookingService.js");

    const late = new Date(new Date(booking.startsAt).getTime() - 30 * 60_000);
    await expect(refundBooking(booking.id, booking.userId, late)).rejects.toMatchObject({ status: 409 });

    const res = await request(app).get(`/api/bookings/${booking.id}`).set("Authorization", auth);
    expect((res.body as { booking: Booking }).booking.status).toBe("confirmed");
  }, 30_000);
});

describe("legacy cancel", () => {
  it("reverses the charge too (the UI always promised a refund)", async () => {
    const { auth, booking, intent } = await paidBooking("cancel-refunds@example.com", "+12025550126");

    const res = await request(app).post(`/api/bookings/${booking.id}/cancel`).set("Authorization", auth);
    expect(res.status).toBe(200);
    expect((res.body as { booking: Booking }).booking.status).toBe("cancelled");
    expect(await paymentStatus(auth, intent.id)).toBe("refunded");
  }, 30_000);
});
