import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, teardownTestApp } from "./setup.js";
import request from "supertest";
import type { Express } from "express";
import type { EmailMessage } from "../src/services/email/types.js";
import type { AuthSession, Booking, PaymentIntent, SeatMap } from "../../shared/types.js";

let app: Express;
let tempDir: string;
let drainEmailOutbox: () => EmailMessage[];

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-notify-");
  app = ctx.app;
  tempDir = ctx.tempDir;
  // Dynamic: static src imports would parse `env` (and DATA_DIR) too early.
  ({ drainEmailOutbox } = await import("../src/services/email/mock.js"));
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

const TEST_CARD = { number: "4242 4242 4242 4242", name: "Notify Tester", expiry: "12/30", cvc: "123" };

async function signUp(email: string): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Notify Tester", email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as AuthSession;
}

async function encryptedCard() {
  const { getPaymentKeyPair, encryptLikeBrowser } = await import("../src/services/cryptoService.js");
  const { keyId, publicKey } = getPaymentKeyPair();
  return { keyId, encrypted: encryptLikeBrowser(JSON.stringify(TEST_CARD), publicKey) };
}

/** Full purchase: hold → booking → intent → verify. Returns the paid booking. */
async function buyTicket(email: string, phone: string): Promise<Booking> {
  const session = await signUp(email);
  const auth = `Bearer ${session.accessToken}`;
  const screening = (await request(app).get("/api/movies/furiosa")).body as {
    screenings: Array<{ days: Array<{ times: Array<{ showtimeId: string }> }> }>;
  };
  const showtimeId = screening.screenings[0]!.days.at(-1)!.times[0]!.showtimeId;
  const seatMap = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatMap;
  const seat = seatMap.seats.find((candidate) => candidate.status === "available")!;
  const hold = await request(app)
    .post(`/api/showtimes/${showtimeId}/holds`)
    .send({ seatIds: [seat.id] });
  expect(hold.status).toBe(200);

  const bookingRes = await request(app)
    .post("/api/bookings")
    .set("Authorization", auth)
    .send({ showtimeId, seatIds: [seat.id], holdToken: (hold.body as { holdToken: string }).holdToken });
  expect(bookingRes.status, JSON.stringify(bookingRes.body)).toBe(201);
  const booking = (bookingRes.body as { booking: Booking }).booking;

  const intentRes = await request(app)
    .post("/api/payments/intents")
    .set("Authorization", auth)
    .send({ bookingId: booking.id, method: "card", phone, card: await encryptedCard() });
  expect(intentRes.status, JSON.stringify(intentRes.body)).toBe(201);
  const intent = (intentRes.body as { payment: PaymentIntent }).payment;

  const verify = await request(app)
    .post(`/api/payments/${intent.id}/verify`)
    .set("Authorization", auth)
    .send({ code: intent.devCode! });
  expect(verify.status, JSON.stringify(verify.body)).toBe(200);
  return (verify.body as { booking: Booking }).booking;
}

describe("payment notifications (inline pipeline)", () => {
  it("emails the ticket with QR + PDF receipt on payment", async () => {
    drainEmailOutbox();
    const paid = await buyTicket("notify-buyer@example.com", "+12025550131");
    expect(paid.status).toBe("confirmed");

    const outbox = drainEmailOutbox();
    expect(outbox).toHaveLength(1);
    const email = outbox[0]!;
    expect(email.to).toBe("notify-buyer@example.com");
    expect(email.subject).toContain(paid.code);
    expect(email.html).toContain(paid.code);
    expect(email.html).toContain("Furiosa");
    const qr = email.attachments?.find((attachment) => attachment.filename === "ticket-qr.png");
    expect(qr?.contentType).toBe("image/png");
    expect(qr?.cid).toBe("ticket-qr");
    const pdf = email.attachments?.find((attachment) => attachment.filename === `receipt-${paid.code}.pdf`);
    expect(pdf?.contentType).toBe("application/pdf");
    expect(pdf?.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("re-sends the receipt via POST /bookings/:id/receipt (202)", async () => {
    const paid = await buyTicket("notify-receipt@example.com", "+12025550132");
    drainEmailOutbox();

    const session = await request(app)
      .post("/api/auth/login")
      .send({ email: "notify-receipt@example.com", password: "Str0ngPassw0rd" });
    const res = await request(app)
      .post(`/api/bookings/${paid.id}/receipt`)
      .set("Authorization", `Bearer ${(session.body as AuthSession).accessToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });

    const outbox = drainEmailOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toContain(`Receipt for ${paid.code}`);
    expect(
      outbox[0]!.attachments?.some((attachment) => attachment.filename === `receipt-${paid.code}.pdf`),
    ).toBe(true);
  });

  it("refuses receipts for unpaid bookings (409)", async () => {
    const session = await signUp("notify-pending@example.com");
    const screening = (await request(app).get("/api/movies/furiosa")).body as {
      screenings: Array<{ days: Array<{ times: Array<{ showtimeId: string }> }> }>;
    };
    const showtimeId = screening.screenings[0]!.days.at(-1)!.times[0]!.showtimeId;
    const seatMap = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatMap;
    const seat = seatMap.seats.find((candidate) => candidate.status === "available")!;
    const hold = await request(app)
      .post(`/api/showtimes/${showtimeId}/holds`)
      .send({ seatIds: [seat.id] });
    const bookingRes = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({ showtimeId, seatIds: [seat.id], holdToken: (hold.body as { holdToken: string }).holdToken });
    expect(bookingRes.status).toBe(201);
    const booking = (bookingRes.body as { booking: Booking }).booking;

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/receipt`)
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("hides other users' bookings behind 404", async () => {
    const paid = await buyTicket("notify-owner@example.com", "+12025550133");
    const stranger = await signUp("notify-stranger@example.com");
    const res = await request(app)
      .post(`/api/bookings/${paid.id}/receipt`)
      .set("Authorization", `Bearer ${stranger.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/bookings/bkg_nope/receipt");
    expect(res.status).toBe(401);
  });
});
