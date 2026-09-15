import QRCode from "qrcode";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { QueuedAttachment } from "../queues/types.js";
import { emailProvider, emailProviderName } from "./email/factory.js";
import { maskEmail } from "./email/mock.js";
import type { EmailMessage } from "./email/types.js";
import type { Booking } from "../../../shared/types.js";

export interface SendEmailResult {
  delivered: boolean;
  provider: string;
}

/**
 * Sends one email via the configured provider. Never throws (callers that
 * need retries — the queue pipeline — check `delivered` themselves).
 */
export async function sendEmail(message: EmailMessage): Promise<SendEmailResult> {
  const name = emailProviderName();
  if (name === "mock" && env.isProduction) {
    logger.error({ to: maskEmail(message.to) }, "email provider is not configured; message not delivered");
    return { delivered: false, provider: "unconfigured" };
  }
  try {
    const result = await emailProvider().send(message);
    if (result.delivered) {
      logger.info({ to: maskEmail(message.to), provider: name, messageId: result.messageId }, "email sent");
    } else {
      logger.error({ to: maskEmail(message.to), provider: name }, "email provider failed to deliver");
    }
    return { delivered: result.delivered, provider: name };
  } catch (error) {
    logger.error({ err: error, to: maskEmail(message.to), provider: name }, "email send failed");
    return { delivered: false, provider: name };
  }
}

export type TicketEmailTemplate = "ticket" | "receipt" | "refund";

export interface MagicLinkEmailInput {
  to: string;
  /** One-time sign-in URL built from the signed token. */
  url: string;
  minutes: number;
}

/**
 * Passwordless sign-in mail (ТЗ §6: email — билеты, чеки, magic link).
 * The token is single-use; this template only renders it.
 */
export function buildMagicLinkEmail(input: MagicLinkEmailInput): EmailMessage {
  const { to, url, minutes } = input;
  const safeUrl = esc(url);
  const html = [
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`,
    `<div style="background:#0d3b2e;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">`,
    `<div style="font-size:20px;font-weight:bold">CineTickets</div>`,
    `<div style="font-size:14px;opacity:.85">Sign in with a magic link</div>`,
    `</div>`,
    `<div style="border:1px solid #e5e5e5;padding:24px;border-radius:0 0 12px 12px">`,
    `<p style="font-size:15px">Tap the button below to sign in. The link works once and expires in ${minutes} minutes.</p>`,
    `<p style="text-align:center;margin:28px 0">`,
    `<a href="${safeUrl}" style="display:inline-block;background:#0d3b2e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px">Sign in to CineTickets</a>`,
    `</p>`,
    `<p style="font-size:13px;color:#555">If the button does not work, copy this address into your browser:<br>`,
    `<span style="font-family:monospace;word-break:break-all">${safeUrl}</span></p>`,
    `<p style="font-size:12px;color:#777">Didn't request this? You can safely ignore this email.</p>`,
    `</div></div>`,
  ].join("\n");
  const text = [
    "CineTickets — sign in",
    "",
    `Open this link to sign in (valid for ${minutes} minutes, single use):`,
    url,
    "",
    "Didn't request this? You can safely ignore this email.",
  ].join("\n");
  return { to, subject: "Your CineTickets sign-in link", html, text };
}

export interface TicketEmailInput {
  booking: Booking;
  to: string;
  template: TicketEmailTemplate;
  /** Receipt PDF (rendered by the pdf queue — the email side only attaches it). */
  receiptPdf: Buffer;
}

export const TICKET_QR_CID = "ticket-qr";

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * Ticket/receipt email: QR code (opens the ticket page) inline + PDF receipt
 * attached. Localized down the road — the server doesn't track user locale yet.
 */
export async function buildTicketEmail(input: TicketEmailInput): Promise<EmailMessage> {
  const { booking, to, template, receiptPdf } = input;
  const ticketUrl = `${env.APP_PUBLIC_URL}/tickets/${booking.id}`;
  const qrDataUrl = await QRCode.toDataURL(ticketUrl, { width: 220, margin: 2 });
  const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const when = new Date(booking.startsAt).toUTCString();
  const seats = booking.seats.map((seat) => `${seat.label} (${seat.seatClass})`).join(", ");
  const total = money(booking.quote.totalCents, booking.currency);
  const isRefund = template === "refund";
  const heading =
    template === "ticket"
      ? "Your tickets are confirmed"
      : isRefund
        ? "Your refund is on its way"
        : "Your receipt";
  const intro = isRefund
    ? `The payment for booking ${esc(booking.code)} (${esc(total)}) was reversed to your original payment method — it usually arrives within a few business days.`
    : template === "ticket"
      ? `Show this QR code at the entrance — it opens your ticket (${esc(booking.code)}).`
      : `A copy of the receipt for booking ${esc(booking.code)} is attached as a PDF.`;
  const subject = isRefund
    ? `Refund for ${booking.code} — CineTickets`
    : template === "ticket"
      ? `Your CineTickets tickets — ${booking.movie.title} (${booking.code})`
      : `Receipt for ${booking.code} — CineTickets`;
  const totalLabel = isRefund ? "Total refunded" : "Total charged";

  const html = [
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`,
    `<div style="background:#0d3b2e;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">`,
    `<div style="font-size:20px;font-weight:bold">CineTickets</div>`,
    `<div style="font-size:14px;opacity:.85">${heading}</div>`,
    `</div>`,
    `<div style="border:1px solid #e5e5e5;border-top:1px solid #e5e5e5;padding:24px;border-radius:0 0 12px 12px">`,
    `<p style="font-size:15px">${intro}</p>`,
    `<p style="font-size:16px"><strong>${esc(booking.movie.title)}</strong><br>`,
    `<span style="color:#555">${esc(booking.theaterName)} · ${esc(booking.hall)}<br>${esc(when)}<br>Seats: ${esc(seats)}</span></p>`,
    `<p style="font-size:15px">Booking code: <strong style="font-family:monospace">${esc(booking.code)}</strong><br>${totalLabel}: <strong>${esc(total)}</strong></p>`,
    ...(isRefund
      ? []
      : [
          `<p style="text-align:center"><img src="cid:${TICKET_QR_CID}" alt="Ticket QR code" width="220" style="border:1px solid #eee"></p>`,
          `<p style="text-align:center"><a href="${esc(ticketUrl)}" style="display:inline-block;background:#0d3b2e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px">Open my ticket</a></p>`,
        ]),
    `<p style="font-size:12px;color:#777">The PDF receipt is attached to this email.</p>`,
    `</div></div>`,
  ].join("\n");

  const text = [
    `CineTickets — ${heading}`,
    ``,
    template === "ticket"
      ? `Show the attached QR code at the entrance — it opens your ticket (${booking.code}).`
      : `A copy of the receipt for booking ${booking.code} is attached as a PDF.`,
    ``,
    `${booking.movie.title}`,
    `${booking.theaterName} · ${booking.hall}`,
    `${when}`,
    `Seats: ${seats}`,
    `Booking code: ${booking.code}`,
    `Total charged: ${total}`,
    ``,
    `Open your ticket: ${ticketUrl}`,
  ].join("\n");

  const attachments: QueuedAttachment[] = [
    ...(isRefund
      ? []
      : [
          {
            filename: "ticket-qr.png",
            contentType: "image/png",
            contentBase64: qrBase64,
            cid: TICKET_QR_CID,
          },
        ]),
    {
      filename: `receipt-${booking.code}.pdf`,
      contentType: "application/pdf",
      contentBase64: receiptPdf.toString("base64"),
    },
  ];

  return {
    to,
    subject,
    html,
    text,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.contentBase64, "base64"),
      cid: attachment.cid,
    })),
  };
}
