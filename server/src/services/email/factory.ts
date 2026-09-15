import { env } from "../../config/env.js";
import { MockEmailProvider } from "./mock.js";
import { SendgridEmailProvider } from "./sendgrid.js";
import { SmtpEmailProvider } from "./smtp.js";
import type { EmailProvider, EmailProviderName } from "./types.js";

/**
 * Resolves the email backend.
 *
 * - Explicit `EMAIL_PROVIDER` always wins.
 * - Otherwise `SENDGRID_API_KEY` selects SendGrid, `SMTP_HOST` selects SMTP.
 * - Otherwise `mock` (in-memory outbox; refused in production by `sendEmail`).
 */
const instances = new Map<EmailProviderName, EmailProvider>();

export function emailProviderName(): EmailProviderName {
  if (env.EMAIL_PROVIDER) return env.EMAIL_PROVIDER;
  if (env.SENDGRID_API_KEY) return "sendgrid";
  return env.SMTP_HOST ? "smtp" : "mock";
}

export function emailProvider(): EmailProvider {
  const name = emailProviderName();
  const existing = instances.get(name);
  if (existing) return existing;
  let provider: EmailProvider;
  switch (name) {
    case "smtp":
      provider = new SmtpEmailProvider();
      break;
    case "sendgrid":
      provider = new SendgridEmailProvider();
      break;
    case "mock":
    default:
      provider = new MockEmailProvider();
      break;
  }
  instances.set(name, provider);
  return provider;
}

/** Test helper: drops cached instances so constructor errors can be re-triggered. */
export function __resetEmailProviders(): void {
  instances.clear();
}
