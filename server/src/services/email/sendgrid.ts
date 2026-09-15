import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { fetchWithTimeout } from "../sms/http.js";
import { maskEmail } from "./mock.js";
import type { EmailMessage, EmailProvider, EmailProviderName, EmailSendResult } from "./types.js";

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const SENDGRID_TIMEOUT_MS = 10_000;

export interface SendgridConfig {
  apiKey: string;
  from: string;
}

/** SendGrid Web API v3 (https://docs.sendgrid.com/api-reference/mail-send). */
export class SendgridEmailProvider implements EmailProvider {
  readonly name: EmailProviderName = "sendgrid";
  private readonly config: SendgridConfig;

  constructor(config: Partial<SendgridConfig> = {}) {
    const apiKey = config.apiKey ?? env.SENDGRID_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("SENDGRID_API_KEY must be set for the sendgrid email provider");
    }
    this.config = { apiKey, from: config.from ?? env.EMAIL_FROM };
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const from = parseFrom(this.config.from);
    let response: Response;
    try {
      response = await fetchWithTimeout(
        SENDGRID_API_URL,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: message.to }] }],
            from,
            subject: message.subject,
            content: [
              { type: "text/plain", value: message.text },
              { type: "text/html", value: message.html },
            ],
            attachments: message.attachments?.map((attachment) => ({
              content: attachment.content.toString("base64"),
              filename: attachment.filename,
              type: attachment.contentType,
              disposition: attachment.cid ? "inline" : "attachment",
              content_id: attachment.cid,
            })),
          }),
        },
        SENDGRID_TIMEOUT_MS,
      );
    } catch (error) {
      logger.error({ err: error, to: maskEmail(message.to) }, "sendgrid request failed");
      return { delivered: false };
    }
    if (!response.ok) {
      logger.error({ to: maskEmail(message.to), status: response.status }, "sendgrid rejected the message");
      return { delivered: false };
    }
    logger.info({ to: maskEmail(message.to), provider: this.name, status: response.status }, "email sent");
    return { delivered: true, messageId: response.headers.get("x-message-id") ?? undefined };
  }
}

/** `"CineTickets <no-reply@…>"` → `{ name, email }` (plain address → name omitted). */
export function parseFrom(raw: string): { email: string; name?: string } {
  const match = /^(.*)<([^<>@\s]+@[^<>@\s]+)>\s*$/.exec(raw.trim());
  if (match?.[2]) {
    const name = (match[1] ?? "").trim().replace(/^"|"$/g, "");
    return name ? { email: match[2], name } : { email: match[2] };
  }
  return { email: raw.trim() };
}
