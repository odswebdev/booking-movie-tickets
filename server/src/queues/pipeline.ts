import { findStoredBooking, toBooking } from "../services/bookingService.js";
import { maskEmail } from "../services/email/mock.js";
import { buildTicketEmail, sendEmail } from "../services/emailService.js";
import { generateReceiptPdf } from "../services/pdfService.js";
import { maskPhone, sendSmsCode } from "../services/smsService.js";
import type { EmailMessage } from "../services/email/types.js";
import type { EmailSendJobData, PdfJobData, QueuedEmailMessage, SmsJobData } from "./types.js";

/**
 * The actual job logic. Runs in-process (inline driver) or inside the worker
 * (BullMQ driver) — the same functions either way. Every function throws on
 * failure so BullMQ retries with backoff; the inline driver propagates the
 * error to the caller, which decides whether the user sees it.
 */

/** SMS code delivery (OTP). */
export async function processSmsSend(data: SmsJobData): Promise<void> {
  const result = await sendSmsCode(data.phone, data.code);
  if (!result.delivered) {
    throw new Error(`SMS to ${maskPhone(data.phone)} was not delivered`);
  }
}

/**
 * PDF job: renders the receipt and returns the email that carries it.
 * The caller (`enqueueTicketEmail` / the worker) forwards the result to the
 * email queue — the pdf queue never sends email itself.
 */
export async function buildTicketEmailData(data: PdfJobData): Promise<EmailSendJobData> {
  const stored = await findStoredBooking(data.bookingId);
  if (!stored) {
    throw new Error(`booking ${data.bookingId} not found for the ${data.template} email`);
  }
  const booking = toBooking(stored);
  const receiptPdf = await generateReceiptPdf(booking);
  const email = await buildTicketEmail({ booking, to: data.to, template: data.template, receiptPdf });
  return { message: toQueuedMessage(email) };
}

/** Email job: delivers one fully-rendered message. */
export async function deliverEmailSend(data: EmailSendJobData): Promise<void> {
  const result = await sendEmail(fromQueuedMessage(data.message));
  if (!result.delivered) {
    throw new Error(`email to ${maskEmail(data.message.to)} was not delivered`);
  }
}

function toQueuedMessage(email: EmailMessage): QueuedEmailMessage {
  return {
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments: email.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      contentBase64: attachment.content.toString("base64"),
      cid: attachment.cid,
    })),
  };
}

function fromQueuedMessage(message: QueuedEmailMessage): EmailMessage {
  return {
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    attachments: message.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.contentBase64, "base64"),
      cid: attachment.cid,
    })),
  };
}
