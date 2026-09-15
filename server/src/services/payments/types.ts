import type { Currency, PaymentMethod } from "../../../../shared/types.js";

/**
 * Payment providers (Strategy pattern).
 *
 * The booking flow stays the same for every PSP: the client collects the
 * payment details, the user confirms with an SMS code, and only then is the
 * charge executed via the configured provider. Providers that need an extra
 * customer step (3-D Secure, PayPal approval) return `requires_action` with a
 * URL — the booking is confirmed later, by the provider's webhook.
 */

export type PaymentProviderName = "mock" | "yookassa" | "stripe" | "paypal";

export type ChargeStatus = "succeeded" | "requires_action" | "pending";

export interface CardMethodData {
  kind: "card";
  /** PAN/expiry/CVC decrypted in memory only — never logged, never stored. */
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
  holder: string;
}

/**
 * PCI-friendly card data: the browser tokenized the card inside the provider's
 * widget, so only an opaque token reaches this process (ТЗ §5–6).
 */
export interface CardTokenMethodData {
  kind: "card_token";
  /** Provider-side token (YooKassa `payment_token`, Stripe PaymentMethod id). */
  token: string;
  /** Which widget produced the token. */
  provider: "yookassa" | "stripe";
  /** Set when the token came from Apple Pay / Google Pay. */
  wallet?: "apple_pay" | "google_pay";
}

export interface PayPalMethodData {
  kind: "paypal";
  /** Payer email is informational — order creation does not need it. */
  email?: string;
}

export type ChargeMethodData = CardMethodData | CardTokenMethodData | PayPalMethodData;

export interface ChargeInput {
  /** Our idempotency key (the payment intent id) — sent to the PSP so a retry never double-charges. */
  idempotencyKey: string;
  bookingId: string;
  amountCents: number;
  currency: Currency;
  method: PaymentMethod;
  methodData: ChargeMethodData;
  description: string;
  /** Where the PSP sends the customer back after an off-site step (3DS, approval). */
  returnUrl: string;
  customerEmail?: string;
}

export interface ChargeResult {
  status: ChargeStatus;
  /** PSP-side payment id (YooKassa payment id, Stripe PI id, PayPal order id). */
  providerRef: string;
  /** Set when status is `requires_action` (3DS / approval URL). */
  actionUrl?: string;
}

export interface RefundInput {
  providerRef: string;
  amountCents: number;
  currency: Currency;
  reason?: string;
}

/** Normalised outcome of a verified provider webhook event. */
export interface ProviderWebhookOutcome {
  /** Provider-side event id — the idempotency key for event processing. */
  eventId: string;
  providerRef: string;
  status: "succeeded" | "failed" | "pending";
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Executes (or starts) the charge. Throws ProviderChargeError on decline / gateway failure. */
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(input: RefundInput): Promise<void>;
  /**
   * Verifies authenticity (signature / API round-trip) and normalises the event.
   * Must throw (never return null) when the event cannot be trusted.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<ProviderWebhookOutcome>;
}

export type ProviderErrorKind = "declined" | "gateway" | "unavailable" | "invalid_webhook";

/** Internal error — the service layer maps it to ApiError.paymentFailed. */
export class ProviderChargeError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly retryable: boolean;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderChargeError";
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === "gateway" || kind === "unavailable");
  }

  static declined(message: string): ProviderChargeError {
    return new ProviderChargeError("declined", message, { retryable: false });
  }

  static gateway(message: string, cause?: unknown): ProviderChargeError {
    return new ProviderChargeError("gateway", message, { retryable: true, cause });
  }

  static unavailable(message: string): ProviderChargeError {
    return new ProviderChargeError("unavailable", message, { retryable: true });
  }

  static invalidWebhook(message: string): ProviderChargeError {
    return new ProviderChargeError("invalid_webhook", message, { retryable: false });
  }
}
