import { QueueEvents } from "bullmq";
import type { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, teardownTestApp } from "./setup.js";
import request from "supertest";
import type { Express } from "express";
import { drainEmailOutbox } from "../src/services/email/mock.js";
import type { Redis } from "ioredis";
import { QUEUE_EMAIL, QUEUE_SMS } from "../src/queues/types.js";
import type { AuthSession, Booking, PaymentIntent, SeatMap } from "../../shared/types.js";

const hasRedis = Boolean(process.env.REDIS_URL);

let app: Express;
let tempDir: string;
let workers: Worker[] = [];
let dispatchSmsCode: (phone: string, code: string) => Promise<{ delivered: boolean }>;
let configureQueues: (driver: "inline" | "bullmq" | "auto") => void;
let createQueueConnection: () => Redis;
let startQueueWorkers: () => Worker[];
let closeQueues: () => Promise<void>;
let obliterateAllQueues: () => Promise<void>;

interface CompletionGate {
  /** Resolves once the event subscription is live — enqueue only after this. */
  ready: Promise<void>;
  /** Resolves on the next completed job, rejects on failure/timeout. */
  done: Promise<void>;
}

function waitForCompleted(queueName: string, timeoutMs = 20_000): CompletionGate {
  const events = new QueueEvents(queueName, { connection: createQueueConnection() });
  const ready = events.waitUntilReady();
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void events.close().finally(() => reject(new Error(`timed out waiting for a ${queueName} job`)));
    }, timeoutMs);
    // Handlers attach before `ready` resolves: nothing published afterwards is missed.
    events.on("completed", () => {
      clearTimeout(timer);
      void events.close().finally(() => resolve());
    });
    events.on("failed", (_jobId, message) => {
      clearTimeout(timer);
      void events.close().finally(() => reject(new Error(`a ${queueName} job failed: ${message}`)));
    });
  });
  return { ready, done };
}

describe.runIf(hasRedis)("BullMQ queues (live Redis, in-process workers)", () => {
  beforeAll(async () => {
    const ctx = await setupTestApp("movie-tickets-queues-");
    app = ctx.app;
    tempDir = ctx.tempDir;
    // Dynamic: static src imports would parse `env` (and DATA_DIR) too early.
    const queueService = await import("../src/queues/queueService.js");
    ({ dispatchSmsCode, configureQueues, createQueueConnection, closeQueues, obliterateAllQueues } =
      queueService);
    ({ startQueueWorkers } = await import("../src/queues/runner.js"));
    configureQueues("bullmq");
    await obliterateAllQueues();
    workers = startQueueWorkers();
  }, 60_000);

  afterAll(async () => {
    for (const worker of workers) {
      await worker.close();
    }
    await obliterateAllQueues();
    await closeQueues();
    configureQueues("auto");
    await teardownTestApp(tempDir);
  }, 60_000);

  it("delivers an SMS job through the worker", async () => {
    const gate = waitForCompleted(QUEUE_SMS);
    await gate.ready;
    const result = await dispatchSmsCode("+12025550140", "123456");
    expect(result).toEqual({ delivered: true });
    await gate.done;
  });

  it("flows a ticket email through pdf → email", async () => {
    drainEmailOutbox();
    const email = "notify-queue@example.com";
    const register = await request(app)
      .post("/api/auth/register")
      .send({ name: "Queue Tester", email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
    expect(register.status).toBe(201);
    const session = register.body as AuthSession;
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
    const bookingRes = await request(app)
      .post("/api/bookings")
      .set("Authorization", auth)
      .send({ showtimeId, seatIds: [seat.id], holdToken: (hold.body as { holdToken: string }).holdToken });
    const booking = (bookingRes.body as { booking: Booking }).booking;

    const { getPaymentKeyPair, encryptLikeBrowser } = await import("../src/services/cryptoService.js");
    const { keyId, publicKey } = getPaymentKeyPair();
    const card = {
      keyId,
      encrypted: encryptLikeBrowser(
        JSON.stringify({ number: "4242 4242 4242 4242", name: "Queue Tester", expiry: "12/30", cvc: "123" }),
        publicKey,
      ),
    };
    const intentRes = await request(app)
      .post("/api/payments/intents")
      .set("Authorization", auth)
      .send({ bookingId: booking.id, method: "card", phone: "+12025550141", card });
    const intent = (intentRes.body as { payment: PaymentIntent }).payment;

    const gate = waitForCompleted(QUEUE_EMAIL);
    await gate.ready;
    const verify = await request(app)
      .post(`/api/payments/${intent.id}/verify`)
      .set("Authorization", auth)
      .send({ code: intent.devCode! });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    await gate.done;

    const outbox = drainEmailOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(email);
    expect(outbox[0]!.attachments?.some((attachment) => attachment.filename.endsWith(".pdf"))).toBe(true);
  }, 60_000);
});
