/**
 * BullMQ queue names (shared by the API, the worker and tests).
 * No colons — BullMQ reserves `:` as its Redis key separator.
 */
export const QUEUE_SMS = "cinetickets-sms";
export const QUEUE_EMAIL = "cinetickets-email";
export const QUEUE_PDF = "cinetickets-pdf";

export interface SmsJobData {
  phone: string;
  code: string;
}

export interface PdfJobData {
  bookingId: string;
  to: string;
  template: "ticket" | "receipt" | "refund";
}

/** JSON-safe attachment (BullMQ serializes job data into Redis). */
export interface QueuedAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  cid?: string;
}

export interface QueuedEmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: QueuedAttachment[];
}

export interface EmailSendJobData {
  message: QueuedEmailMessage;
}
