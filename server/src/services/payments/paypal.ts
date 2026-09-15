import { env } from "../../config/env.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { minorToDecimal, postJson } from "./http.js";
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
 * PayPal Checkout (Orders v2 + Payments v2).
 *
 * PayPal always needs the payer's approval on paypal.com, so `charge` creates
 * an order and returns `requires_action` with the approval URL; the booking is
 * confirmed by the `PAYMENT.CAPTURE.COMPLETED` / `CHECKOUT.ORDER.APPROVED`
 * webhook after the payer approves (we capture on approval).
 */

interface PayPalConfig {
  clientId: string;
  secret: string;
  apiUrl: string;
  webhookId: string;
}

interface PayPalOrder {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED" | "VOIDED" | "PAYER_ACTION_REQUIRED";
  links?: Array<{ rel: string; href: string }>;
}

export class PayPalProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "paypal";
  private readonly breaker = new CircuitBreaker({ name: "paypal" });
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: PayPalConfig = {
      clientId: env.PAYPAL_CLIENT_ID ?? "",
      secret: env.PAYPAL_SECRET ?? "",
      apiUrl: env.PAYPAL_API_URL,
      webhookId: env.PAYPAL_WEBHOOK_ID ?? "",
    },
  ) {
    if (!this.config.clientId || !this.config.secret) {
      throw new Error("PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_SECRET");
    }
  }

  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const response = await fetch(`${this.config.apiUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw ProviderChargeError.gateway(`PayPal auth answered with HTTP ${response.status}`);
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    return this.breaker.run(
      async () => {
        const token = await this.accessToken();
        const { status, data } = await postJson<PayPalOrder>(
          `${this.config.apiUrl}/v2/checkout/orders`,
          {
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: input.bookingId,
                description: input.description.slice(0, 127),
                amount: { currency_code: input.currency, value: minorToDecimal(input.amountCents) },
              },
            ],
            application_context: {
              return_url: input.returnUrl,
              cancel_url: input.returnUrl,
              user_action: "PAY_NOW",
            },
          },
          {
            provider: "paypal",
            headers: {
              Authorization: `Bearer ${token}`,
              "PayPal-Request-Id": input.idempotencyKey,
            },
          },
        );
        if (status === 401 || status === 403) {
          this.tokenCache = null;
          throw ProviderChargeError.gateway("PayPal rejected the API credentials");
        }
        if (status < 200 || status >= 300) {
          throw ProviderChargeError.gateway(`PayPal answered with HTTP ${status}`);
        }
        const approve = data.links?.find(
          (link) => link.rel === "approve" || link.rel === "payer-action",
        )?.href;
        if (!approve) {
          throw ProviderChargeError.gateway("PayPal did not return an approval link");
        }
        return { status: "requires_action", providerRef: data.id, actionUrl: approve };
      },
      () => ProviderChargeError.unavailable("PayPal is temporarily unavailable. Please try again."),
    );
  }

  /** Captures an approved order — called from the webhook handler. */
  async captureOrder(orderId: string): Promise<"succeeded" | "failed"> {
    const token = await this.accessToken();
    const { status, data } = await postJson<{ status?: string }>(
      `${this.config.apiUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {},
      {
        provider: "paypal",
        headers: {
          Authorization: `Bearer ${token}`,
          "PayPal-Request-Id": `capture_${orderId}`,
        },
      },
    );
    if (status < 200 || status >= 300) return "failed";
    return data.status === "COMPLETED" ? "succeeded" : "failed";
  }

  async refund(input: RefundInput): Promise<void> {
    await this.breaker.run(
      async () => {
        const token = await this.accessToken();
        // providerRef for PayPal is the capture id (stored after CHECKOUT capture).
        const { status } = await postJson(
          `${this.config.apiUrl}/v2/payments/captures/${encodeURIComponent(input.providerRef)}/refund`,
          {
            amount: { currency_code: input.currency, value: minorToDecimal(input.amountCents) },
            note_to_payer: (input.reason ?? "Ticket refund").slice(0, 255),
          },
          {
            provider: "paypal",
            headers: {
              Authorization: `Bearer ${token}`,
              "PayPal-Request-Id": `refund_${input.providerRef}_${input.amountCents}`,
            },
          },
        );
        if (status < 200 || status >= 300) {
          throw ProviderChargeError.gateway(`PayPal refund answered with HTTP ${status}`);
        }
      },
      () => ProviderChargeError.unavailable("PayPal is temporarily unavailable. Please try again."),
    );
  }

  /**
   * Verifies the event with PayPal's verify-webhook-signature API.
   * Outside production the check is skipped (sandbox webhooks can be
   * replayed with `PAYPAL_WEBHOOK_ID` unset) — but it is mandatory in prod.
   */
  async verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<ProviderWebhookOutcome> {
    let event: {
      id?: string;
      event_type?: string;
      resource?: {
        id?: string;
        status?: string;
        supplementary_data?: { related_ids?: { order_id?: string } };
      };
    };
    try {
      event = JSON.parse(rawBody.toString("utf8")) as typeof event;
    } catch {
      throw ProviderChargeError.invalidWebhook("PayPal webhook is not valid JSON");
    }
    if (!event.id || !event.event_type || !event.resource?.id) {
      throw ProviderChargeError.invalidWebhook("PayPal webhook has an unexpected shape");
    }

    if (env.isProduction || this.config.webhookId) {
      const token = await this.accessToken();
      const { status, data } = await postJson<{ verification_status?: string }>(
        `${this.config.apiUrl}/v1/notifications/verify-webhook-signature`,
        {
          transmission_id: headers["paypal-transmission-id"],
          transmission_time: headers["paypal-transmission-time"],
          transmission_sig: headers["paypal-transmission-sig"],
          cert_url: headers["paypal-cert-url"],
          auth_algo: headers["paypal-auth-algo"],
          webhook_id: this.config.webhookId,
          webhook_event: event,
        },
        { provider: "paypal", headers: { Authorization: `Bearer ${token}` } },
      );
      if (status < 200 || status >= 300 || data.verification_status !== "SUCCESS") {
        throw ProviderChargeError.invalidWebhook("PayPal webhook signature check failed");
      }
    }

    const type = event.event_type;
    if (type === "PAYMENT.CAPTURE.COMPLETED" || type === "CHECKOUT.ORDER.COMPLETED") {
      return { eventId: event.id, providerRef: event.resource.id, status: "succeeded" };
    }
    if (type === "CHECKOUT.ORDER.APPROVED") {
      // Approve → capture synchronously, then confirm the booking.
      const capture = await this.captureOrder(event.resource.id);
      return { eventId: event.id, providerRef: event.resource.id, status: capture };
    }
    if (type === "PAYMENT.CAPTURE.DENIED" || type === "CHECKOUT.ORDER.VOIDED") {
      return { eventId: event.id, providerRef: event.resource.id, status: "failed" };
    }
    return { eventId: event.id, providerRef: event.resource.id, status: "pending" };
  }
}
