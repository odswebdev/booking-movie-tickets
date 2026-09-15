import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestApp, teardownTestApp } from "./setup.js";
import request from "supertest";
import type { Express } from "express";
import type { AuthSession, Booking } from "../../shared/types.js";
import { encryptLikeBrowser, getPaymentKeyPair } from "../src/services/cryptoService.js";

let app: Express;
let tempDir: string;

const STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-webhooks-", {
    PAYMENTS_PROVIDER: "mock",
    // Webhook routes construct real providers by name — credentials must exist.
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET,
    YOOKASSA_SHOP_ID: "shop",
    YOOKASSA_SECRET_KEY: "secret",
    YOOKASSA_API_URL: "https://yookassa.test",
  });
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signUp(email: string): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Webhook Tester", email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
  expect(res.status).toBe(201);
  return res.body as AuthSession;
}

interface ScreeningResponse {
  screenings: Array<{ days: Array<{ times: Array<{ showtimeId: string }> }> }>;
}

/** Creates a pending booking + payment intent, then parks the payment in `requires_action`. */
async function parkedPayment(
  provider: string,
  providerRef: string,
): Promise<{ auth: string; bookingId: string }> {
  const session = await signUp(`${providerRef}@example.com`);
  const auth = `Bearer ${session.accessToken}`;
  const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
  const showtimeId = screening.screenings[0]!.days[0]!.times[0]!.showtimeId;
  const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as {
    seats: Array<{ id: string; status: string }>;
  };
  const seatId = seats.seats.find((seat) => seat.status === "available")!.id;

  const bookingRes = await request(app)
    .post("/api/bookings")
    .set("Authorization", auth)
    .send({ showtimeId, seatIds: [seatId] });
  expect(bookingRes.status).toBe(201);
  const bookingId = (bookingRes.body as { booking: Booking }).booking.id;

  const { keyId, publicKey } = getPaymentKeyPair();
  const intentRes = await request(app)
    .post("/api/payments/intents")
    .set("Authorization", auth)
    .send({
      bookingId,
      method: "card",
      phone: "+12025550123",
      card: {
        keyId,
        encrypted: encryptLikeBrowser(
          JSON.stringify({ number: "4242424242424242", name: "Webhook Tester", expiry: "12/30", cvc: "123" }),
          publicKey,
        ),
      },
    });
  expect(intentRes.status).toBe(201);
  const paymentId = (intentRes.body as { payment: { id: string } }).payment.id;

  // White-box: pretend the PSP answered verify with requires_action.
  const { getRepositories } = await import("../src/db/provider.js");
  await getRepositories().payments.update(paymentId, {
    provider,
    providerRef,
    status: "requires_action",
    actionUrl: "https://psp.test/action",
    updatedAt: new Date().toISOString(),
  });
  return { auth, bookingId };
}

function stripeSignature(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("provider webhooks", () => {
  it("confirms the booking on a verified Stripe event, and ignores redelivery", async () => {
    const { auth, bookingId } = await parkedPayment("stripe", "pi_webhook_1");

    const payload = JSON.stringify({
      id: "evt_webhook_1",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_webhook_1", status: "succeeded" } },
    });
    const first = await request(app)
      .post("/api/webhooks/stripe")
      .set("stripe-signature", stripeSignature(payload))
      .set("Content-Type", "application/json")
      .send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.outcome).toBe("confirmed");

    const ticket = await request(app).get(`/api/bookings/${bookingId}`).set("Authorization", auth);
    expect((ticket.body as { booking: Booking }).booking.status).toBe("confirmed");

    // The same event delivered twice must not settle twice.
    const second = await request(app)
      .post("/api/webhooks/stripe")
      .set("stripe-signature", stripeSignature(payload))
      .set("Content-Type", "application/json")
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("already_processed");
  });

  it("rejects forged Stripe webhooks before touching any booking", async () => {
    const payload = JSON.stringify({
      id: "evt_forged",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_nope", status: "succeeded" } },
    });
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("stripe-signature", `t=1,v1=${"0".repeat(64)}`)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(401);
  });

  it("acknowledges but ignores events for unknown payments", async () => {
    const payload = JSON.stringify({
      id: "evt_unknown",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_unknown_ref", status: "succeeded" } },
    });
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("stripe-signature", stripeSignature(payload))
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("ignored");
  });

  it("confirms YooKassa events only after the API round-trip", async () => {
    const { auth, bookingId } = await parkedPayment("yookassa", "yk_webhook_1");

    // Whatever the body claims, the GET /payments/{id} answer is authoritative.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ id: "yk_webhook_1", status: "succeeded", paid: true }),
      }),
    );

    const res = await request(app)
      .post("/api/webhooks/yookassa")
      .set("Content-Type", "application/json")
      .send({ type: "payment.succeeded", object: { id: "yk_webhook_1" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("confirmed");

    const ticket = await request(app).get(`/api/bookings/${bookingId}`).set("Authorization", auth);
    expect((ticket.body as { booking: Booking }).booking.status).toBe("confirmed");
  });

  it("404s unknown or unconfigured providers", async () => {
    const res = await request(app).post("/api/webhooks/acme-pay").send({ ping: true });
    expect(res.status).toBe(404);
  });
});
