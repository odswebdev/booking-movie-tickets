import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { maskPhone, sendSmsCode } from "../services/smsService.js";
import { sendEmail } from "../services/emailService.js";
import type { EmailMessage } from "../services/email/types.js";
import { recordQueueJob } from "../utils/metrics.js";
import { buildTicketEmailData, deliverEmailSend, processSmsSend } from "./pipeline.js";
import { QUEUE_EMAIL, QUEUE_PDF, QUEUE_SMS } from "./types.js";
import type { EmailSendJobData, PdfJobData, SmsJobData } from "./types.js";

export type QueuesDriver = "inline" | "bullmq";

const JOB_OPTS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 500,
} as const;

let driverOverride: QueuesDriver | null = null;

/** Pins the driver (worker entry, tests); `auto` restores env-based detection. */
export function configureQueues(driver: QueuesDriver | "auto" = "auto"): void {
  driverOverride = driver === "auto" ? null : driver;
}

export function queuesDriver(): QueuesDriver {
  if (driverOverride) return driverOverride;
  if (env.QUEUES_DRIVER === "inline") return "inline";
  if (env.QUEUES_DRIVER === "bullmq") return "bullmq";
  if (env.isTest) return "inline";
  return env.REDIS_URL ? "bullmq" : "inline";
}

/** Dedicated connection per handle (BullMQ forbids sharing blocking connections). */
export function createQueueConnection(): Redis {
  // BullMQ paces commands with its own retry layer; ioredis must not retry.
  return new Redis(env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
}

const handles = new Map<string, Queue>();

function bullmqQueue(name: string): Queue {
  let queue = handles.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createQueueConnection() });
    handles.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  for (const queue of handles.values()) {
    await queue.close();
  }
  handles.clear();
}

/** Test helper: wipes all three queues (waiting + finished jobs). */
export async function obliterateAllQueues(): Promise<void> {
  if (queuesDriver() !== "bullmq") return;
  for (const name of [QUEUE_SMS, QUEUE_EMAIL, QUEUE_PDF]) {
    await bullmqQueue(name).obliterate({ force: true });
  }
}

/**
 * SMS code delivery: sent in-process on the inline driver, enqueued for the
 * worker on BullMQ. Returns the gateway result inline, `{ delivered: true }`
 * (accepted for delivery) when queued.
 */
export async function dispatchSmsCode(phone: string, code: string): Promise<{ delivered: boolean }> {
  if (queuesDriver() === "inline") {
    try {
      const result = await sendSmsCode(phone, code);
      recordQueueJob(QUEUE_SMS, result.delivered);
      return result;
    } catch (error) {
      recordQueueJob(QUEUE_SMS, false);
      throw error;
    }
  }
  const data: SmsJobData = { phone, code };
  try {
    await bullmqQueue(QUEUE_SMS).add("send", data, { ...JOB_OPTS });
  } catch (error) {
    recordQueueJob(QUEUE_SMS, false);
    throw error;
  }
  recordQueueJob(QUEUE_SMS, true);
  logger.info({ phone: maskPhone(phone) }, "sms job queued");
  return { delivered: true };
}

/**
 * Generic e-mail send: magic links and other transactional mail that is not
 * tied to a booking. Inline driver delivers immediately, BullMQ enqueues.
 */
export async function enqueueEmailMessage(message: EmailMessage): Promise<{ delivered: boolean }> {
  const data: EmailSendJobData = {
    message: {
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentBase64: attachment.content.toString("base64"),
        cid: attachment.cid,
      })),
    },
  };
  if (queuesDriver() === "inline") {
    const result = await sendEmail(message);
    recordQueueJob(QUEUE_EMAIL, result.delivered);
    return { delivered: result.delivered };
  }
  try {
    await bullmqQueue(QUEUE_EMAIL).add("send", data, { ...JOB_OPTS });
    recordQueueJob(QUEUE_EMAIL, true);
    return { delivered: true };
  } catch (error) {
    recordQueueJob(QUEUE_EMAIL, false);
    throw error;
  }
}

/** Ticket email (confirmation + QR + PDF receipt) for a freshly paid booking. */
export async function enqueueTicketEmail(bookingId: string, to: string): Promise<void> {
  await enqueuePdfEmail({ bookingId, to, template: "ticket" });
}

/** Same content, "here is your receipt again" framing (resend endpoint). */
export async function enqueueReceiptEmail(bookingId: string, to: string): Promise<void> {
  await enqueuePdfEmail({ bookingId, to, template: "receipt" });
}

/** "The charge was reversed" framing, sent after a refund (no QR — the ticket is void). */
export async function enqueueRefundEmail(bookingId: string, to: string): Promise<void> {
  await enqueuePdfEmail({ bookingId, to, template: "refund" });
}

async function enqueuePdfEmail(data: PdfJobData): Promise<void> {
  if (queuesDriver() === "inline") {
    try {
      await deliverEmailSend(await buildTicketEmailData(data));
      recordQueueJob(QUEUE_PDF, true);
    } catch (error) {
      recordQueueJob(QUEUE_PDF, false);
      throw error;
    }
    return;
  }
  try {
    await bullmqQueue(QUEUE_PDF).add("render", data, { ...JOB_OPTS });
    recordQueueJob(QUEUE_PDF, true);
  } catch (error) {
    recordQueueJob(QUEUE_PDF, false);
    throw error;
  }
}

async function enqueueEmailSend(data: EmailSendJobData): Promise<void> {
  if (queuesDriver() === "inline") {
    try {
      await deliverEmailSend(data);
      recordQueueJob(QUEUE_EMAIL, true);
    } catch (error) {
      recordQueueJob(QUEUE_EMAIL, false);
      throw error;
    }
    return;
  }
  try {
    await bullmqQueue(QUEUE_EMAIL).add("send", data, { ...JOB_OPTS });
    recordQueueJob(QUEUE_EMAIL, true);
  } catch (error) {
    recordQueueJob(QUEUE_EMAIL, false);
    throw error;
  }
}

/**
 * BullMQ job handlers (wired by the worker runner; the inline driver calls
 * the pipeline directly). Failures throw → retried with backoff, 5 attempts.
 */
export async function handleSmsJob(data: SmsJobData): Promise<void> {
  await processSmsSend(data);
}

export async function handlePdfJob(data: PdfJobData): Promise<void> {
  await enqueueEmailSend(await buildTicketEmailData(data));
}

export async function handleEmailJob(data: EmailSendJobData): Promise<void> {
  await deliverEmailSend(data);
}
