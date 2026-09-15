/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the EmailProvider interface */
import { newId } from "../../utils/ids.js";
import { logger } from "../../utils/logger.js";
import type { EmailMessage, EmailProvider, EmailProviderName, EmailSendResult } from "./types.js";

/** In-memory outbox (demo + deterministic tests). */
const outbox: EmailMessage[] = [];

/**
 * Demo provider: every message is "delivered" into the in-memory outbox.
 * Refused in production — see `sendEmail`.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name: EmailProviderName = "mock";

  async send(message: EmailMessage): Promise<EmailSendResult> {
    outbox.push(message);
    logger.info(
      { to: maskEmail(message.to), subject: message.subject },
      "[email:mock] message accepted (logged, not sent)",
    );
    return { delivered: true, messageId: `mock_${newId("eml").slice(4)}` };
  }
}

/** Test helper: returns queued messages and clears the outbox. */
export function drainEmailOutbox(): EmailMessage[] {
  return outbox.splice(0);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
