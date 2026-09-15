import type { PaymentMethod } from "../../../../shared/types.js";
import { env } from "../../config/env.js";
import { MockProvider } from "./mockProvider.js";
import { PayPalProvider } from "./paypal.js";
import { StripeProvider } from "./stripe.js";
import { YooKassaProvider } from "./yookassa.js";
import type { PaymentProvider, PaymentProviderName } from "./types.js";

/**
 * Resolves the PSP for a payment method.
 *
 * - `PAYMENTS_PROVIDER=mock` (default): everything is simulated, charges settle instantly.
 * - Card payments go to the configured card PSP (`yookassa` | `stripe`).
 * - PayPal payments go to PayPal whenever its credentials are set, otherwise mock.
 */
const instances = new Map<PaymentProviderName, PaymentProvider>();

function getOrCreate(name: PaymentProviderName): PaymentProvider {
  const existing = instances.get(name);
  if (existing) return existing;
  let provider: PaymentProvider;
  switch (name) {
    case "yookassa":
      provider = new YooKassaProvider();
      break;
    case "stripe":
      provider = new StripeProvider();
      break;
    case "paypal":
      provider = new PayPalProvider();
      break;
    case "mock":
    default:
      provider = new MockProvider();
      break;
  }
  instances.set(name, provider);
  return provider;
}

export function providerForMethod(method: PaymentMethod): PaymentProvider {
  if (env.PAYMENTS_PROVIDER === "mock") return getOrCreate("mock");
  if (method === "paypal") {
    return env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET ? getOrCreate("paypal") : getOrCreate("mock");
  }
  if (env.PAYMENTS_PROVIDER === "stripe") return getOrCreate("stripe");
  return getOrCreate("yookassa");
}

/** Resolves a provider by name (used by the webhook router). */
export function providerByName(name: string): PaymentProvider | null {
  if (name === "mock" || name === "yookassa" || name === "stripe" || name === "paypal") {
    try {
      return getOrCreate(name);
    } catch {
      return null; // not configured (missing credentials)
    }
  }
  return null;
}

/** Test helper: drops cached instances so constructor errors can be re-triggered. */
export function __resetProviders(): void {
  instances.clear();
}
