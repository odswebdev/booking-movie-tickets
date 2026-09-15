import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import {
  ProviderChargeError,
  type ChargeInput,
  type ChargeResult,
  type PaymentProvider,
  type PaymentProviderName,
  type ProviderWebhookOutcome,
  type RefundInput,
} from "./types.js";

/**
 * Stripe (https://docs.stripe.com) — Visa/Mastercard/МИР* (*where available),
 * Apple/Google Pay via PaymentElement.
 *
 * Direct API integration (form-encoded, no SDK) to keep dependencies at zero.
 * PCI DSS note: production must use Stripe.js PaymentElement and confirm with
 * a PaymentMethod id — raw PAN over the API is a test/sandbox path only.
 */

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  apiUrl: string;
}

interface StripePaymentIntent {
  id: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "succeeded"
    | "canceled";
  next_action?: { type: string; redirect_to_url?: { url?: string }; use_stripe_sdk?: unknown };
  last_payment_error?: { code?: string; message?: string; decline_code?: string };
}

interface StripeErrorBody {
  error?: { code?: string; message?: string; decline_code?: string; type?: string };
}

const DECLINE_CODES = new Set([
  "card_declined",
  "expired_card",
  "incorrect_cvc",
  "incorrect_number",
  "invalid_expiry_year",
  "invalid_expiry_month",
  "invalid_cvc",
  "insufficient_funds",
  "lost_card",
  "stolen_card",
  "pickup_card",
]);

/** Webhook signatures older than this are rejected (replay protection). */
const WEBHOOK_TOLERANCE_SECONDS = 300;

export class StripeProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "stripe";
  private readonly breaker = new CircuitBreaker({ name: "stripe" });

  constructor(
    private readonly config: StripeConfig = {
      secretKey: env.STRIPE_SECRET_KEY ?? "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
      apiUrl: env.STRIPE_API_URL,
    },
  ) {
    if (!this.config.secretKey) {
      throw new Error("Stripe is not configured: set STRIPE_SECRET_KEY");
    }
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.secretKey}:`).toString("base64")}`;
  }

  private async stripeFetch<T>(
    path: string,
    form: Record<string, string>,
    idempotencyKey: string,
  ): Promise<T> {
    const body = new URLSearchParams(form).toString();
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return (await response.json()) as T;
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (input.methodData.kind !== "card" && input.methodData.kind !== "card_token") {
      throw ProviderChargeError.declined("Stripe provider supports card payments only");
    }
    // PaymentElement / Apple Pay / Google Pay produce a PaymentMethod id —
    // that path never exposes card data to our server (ТЗ §5–6).
    const card = input.methodData.kind === "card" ? input.methodData : null;
    const token = input.methodData.kind === "card_token" ? input.methodData.token : null;
    return this.breaker.run(
      async () => {
        let intent: StripePaymentIntent & StripeErrorBody;
        try {
          // Create + confirm in one call (off-session, auto payment methods).
          intent = await this.stripeFetch<StripePaymentIntent & StripeErrorBody>(
            "/v1/payment_intents",
            {
              amount: String(input.amountCents),
              currency: input.currency.toLowerCase(),
              confirm: "true",
              "automatic_payment_methods[enabled]": "true",
              "automatic_payment_methods[allow_redirects]": "never",
              ...(token
                ? { payment_method: token }
                : {
                    "payment_method_data[type]": "card",
                    "payment_method_data[card][number]": card!.number,
                    "payment_method_data[card][exp_month]": String(Number(card!.expiryMonth)),
                    "payment_method_data[card][exp_year]": card!.expiryYear,
                    "payment_method_data[card][cvc]": card!.cvc,
                    "payment_method_data[billing_details][name]": card!.holder,
                  }),
              description: input.description.slice(0, 200),
              "metadata[bookingId]": input.bookingId,
              return_url: input.returnUrl,
            },
            input.idempotencyKey,
          );
        } catch (error) {
          throw ProviderChargeError.gateway("Stripe is unreachable", error);
        }
        if (intent.error) throw this.mapStripeError(intent.error);
        return this.mapIntent(intent);
      },
      () => ProviderChargeError.unavailable("Stripe is temporarily unavailable. Please try again."),
    );
  }

  async refund(input: RefundInput): Promise<void> {
    await this.breaker.run(
      async () => {
        let result: { error?: StripeErrorBody["error"]; status?: string };
        try {
          result = await this.stripeFetch<{ error?: StripeErrorBody["error"]; status?: string }>(
            "/v1/refunds",
            {
              payment_intent: input.providerRef,
              amount: String(input.amountCents),
              reason: "requested_by_customer",
              "metadata[reason]": (input.reason ?? "Ticket refund").slice(0, 200),
            },
            `refund_${input.providerRef}_${input.amountCents}`,
          );
        } catch (error) {
          throw ProviderChargeError.gateway("Stripe is unreachable", error);
        }
        if (result.error) throw this.mapStripeError(result.error);
      },
      () => ProviderChargeError.unavailable("Stripe is temporarily unavailable. Please try again."),
    );
  }

  /** Verifies the `Stripe-Signature` HMAC (t + "." + raw body, sha256). */
  // eslint-disable-next-line @typescript-eslint/require-await -- async shape is dictated by the PaymentProvider interface
  async verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<ProviderWebhookOutcome> {
    if (!this.config.webhookSecret) {
      throw new Error("Stripe webhooks are not configured: set STRIPE_WEBHOOK_SECRET");
    }
    const signature = headers["stripe-signature"] ?? "";
    const parts: Record<string, string | undefined> = {};
    for (const part of signature.split(",")) {
      const [key, ...rest] = part.split("=");
      const name = key?.trim();
      if (name) parts[name] = rest.join("=");
    }
    const timestamp = Number(parts.t);
    const v1 = parts.v1 ?? "";
    if (!timestamp || !v1) {
      throw ProviderChargeError.invalidWebhook("Stripe webhook signature is missing");
    }
    if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
      throw ProviderChargeError.invalidWebhook("Stripe webhook signature expired");
    }
    const expected = createHmac("sha256", this.config.webhookSecret)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(v1, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw ProviderChargeError.invalidWebhook("Stripe webhook signature mismatch");
    }

    const event = JSON.parse(rawBody.toString("utf8")) as {
      id?: string;
      type?: string;
      data?: { object?: { id?: string; status?: string } };
    };
    const status = event.data?.object?.status;
    return {
      eventId: event.id ?? `${Date.now()}`,
      providerRef: event.data?.object?.id ?? "",
      status: status === "succeeded" ? "succeeded" : status === "canceled" ? "failed" : "pending",
    };
  }

  private mapIntent(intent: StripePaymentIntent): ChargeResult {
    if (intent.status === "succeeded") return { status: "succeeded", providerRef: intent.id };
    if (intent.status === "canceled") {
      throw ProviderChargeError.declined("The card was declined. Try another card or payment method.");
    }
    if (intent.status === "requires_action") {
      const url = intent.next_action?.redirect_to_url?.url;
      if (url) return { status: "requires_action", providerRef: intent.id, actionUrl: url };
      // SDK-only next actions (webauthn etc.) cannot complete in this flow.
      throw ProviderChargeError.declined("This card needs an authentication method we do not support yet.");
    }
    if (intent.status === "requires_payment_method" && intent.last_payment_error) {
      throw this.mapStripeError(intent.last_payment_error);
    }
    return { status: "pending", providerRef: intent.id };
  }

  private mapStripeError(error: NonNullable<StripeErrorBody["error"]>): ProviderChargeError {
    const code = error.decline_code ?? error.code ?? "";
    if (error.type === "card_error" || DECLINE_CODES.has(code)) {
      const friendly =
        code === "insufficient_funds"
          ? "Insufficient funds on this card."
          : code === "expired_card"
            ? "This card has expired."
            : code === "incorrect_cvc"
              ? "The CVC code is incorrect."
              : "The card was declined. Try another card or payment method.";
      return ProviderChargeError.declined(friendly);
    }
    if (error.type === "idempotency_error") {
      return ProviderChargeError.gateway(
        "Duplicate payment request — please check your tickets before retrying.",
      );
    }
    return ProviderChargeError.gateway(error.message ?? "Stripe could not complete the payment.");
  }
}
