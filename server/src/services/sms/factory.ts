import { env } from "../../config/env.js";
import { GenericSmsProvider } from "./generic.js";
import { MockSmsProvider } from "./mock.js";
import { SmsRuProvider } from "./smsru.js";
import { SmscProvider } from "./smsc.js";
import { TwilioProvider } from "./twilio.js";
import type { SmsProvider, SmsProviderName } from "./types.js";

/**
 * Resolves the SMS gateway.
 *
 * - Explicit `SMS_PROVIDER` always wins.
 * - Otherwise a legacy `SMS_PROVIDER_URL` selects the generic HTTP gateway.
 * - Otherwise `mock` (logged locally; refused in production by `sendSmsCode`).
 */
const instances = new Map<SmsProviderName, SmsProvider>();

export function smsProviderName(): SmsProviderName {
  if (env.SMS_PROVIDER) return env.SMS_PROVIDER;
  return env.SMS_PROVIDER_URL ? "generic" : "mock";
}

export function smsProvider(): SmsProvider {
  const name = smsProviderName();
  const existing = instances.get(name);
  if (existing) return existing;
  let provider: SmsProvider;
  switch (name) {
    case "generic":
      provider = new GenericSmsProvider();
      break;
    case "smsru":
      provider = new SmsRuProvider();
      break;
    case "smsc":
      provider = new SmscProvider();
      break;
    case "twilio":
      provider = new TwilioProvider();
      break;
    case "mock":
    default:
      provider = new MockSmsProvider();
      break;
  }
  instances.set(name, provider);
  return provider;
}

/** Test helper: drops cached instances so constructor errors can be re-triggered. */
export function __resetSmsProviders(): void {
  instances.clear();
}
