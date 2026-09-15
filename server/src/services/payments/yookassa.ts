import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { getJson, minorToDecimal, postJson } from "./http.js";
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
 * ЮKassa (https://yookassa.ru/developers) — МИР, Visa/Mastercard, СБП.
 *
 * PCI DSS note: passing raw `bank_card` data to the API requires PCI DSS
 * compliance. Production integrations must tokenize in the browser (YooKassa
 * Checkout widget / Payment form) and send only the token — the provider
 * accepts `PaymentMethodData` so that swap is a one-line change.
 */
interface YooKassaConfig {
  shopId: string;
  secretKey: string;
  apiUrl: string;
}

interface YooKassaPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid?: boolean;
  confirmation?: { type: string; confirmation_url?: string; return_url?: string };
  cancellation_details?: { party?: string; reason?: string };
}

const TERMINAL_FAILURES = new Set([
  "expired_on_confirmation",
  "three_d_secure_failed",
  "call_issuer",
  "not_supported_by_issuer",
  "fraud_suspected",
  "general_decline",
]);

export class YooKassaProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "yookassa";
  private readonly breaker = new CircuitBreaker({ name: "yookassa" });

  constructor(
    private readonly config: YooKassaConfig = {
      shopId: env.YOOKASSA_SHOP_ID ?? "",
      secretKey: env.YOOKASSA_SECRET_KEY ?? "",
      apiUrl: env.YOOKASSA_API_URL,
    },
  ) {
    if (!this.config.shopId || !this.config.secretKey) {
      throw new Error("YooKassa is not configured: set YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY");
    }
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.shopId}:${this.config.secretKey}`).toString("base64")}`;
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (input.methodData.kind !== "card" && input.methodData.kind !== "card_token") {
      throw ProviderChargeError.declined("YooKassa provider supports card payments only");
    }
    // A token from Checkout.js is passed straight through: card data never
    // reaches this process, which is what keeps the integration out of
    // PCI DSS scope (the raw-card branch below is the sandbox fallback).
    const card = input.methodData.kind === "card" ? input.methodData : null;
    const token = input.methodData.kind === "card_token" ? input.methodData.token : null;
    return this.breaker.run(
      async () => {
        const { status, data } = await postJson<YooKassaPayment>(
          `${this.config.apiUrl}/payments`,
          {
            amount: { value: minorToDecimal(input.amountCents), currency: input.currency },
            capture: true,
            confirmation: { type: "redirect", return_url: input.returnUrl },
            description: input.description.slice(0, 128),
            metadata: { bookingId: input.bookingId },
            // Tokenized (widget) path: YooKassa accepts the payment_token from
            // Checkout.js. Raw-card path is the sandbox fallback only.
            ...(token
              ? { payment_token: token }
              : {
                  payment_method_data: {
                    type: "bank_card",
                    card: {
                      number: card!.number,
                      expiry_year: card!.expiryYear,
                      expiry_month: card!.expiryMonth,
                      cvc: card!.cvc,
                      cardholder: card!.holder,
                    },
                  },
                }),
          },
          {
            provider: "yookassa",
            headers: {
              Authorization: this.authHeader,
              "Idempotence-Key": input.idempotencyKey,
            },
          },
        );

        if (status === 401 || status === 403) {
          throw ProviderChargeError.gateway("YooKassa rejected the shop credentials");
        }
        if (status === 400) {
          throw ProviderChargeError.declined("The card was rejected. Check the details and try again.");
        }
        if (status < 200 || status >= 300) {
          throw ProviderChargeError.gateway(`YooKassa answered with HTTP ${status}`);
        }
        return this.mapPayment(data);
      },
      () => ProviderChargeError.unavailable("YooKassa is temporarily unavailable. Please try again."),
    );
  }

  async refund(input: RefundInput): Promise<void> {
    await this.breaker.run(
      async () => {
        const { status } = await postJson(
          `${this.config.apiUrl}/refunds`,
          {
            payment_id: input.providerRef,
            amount: { value: minorToDecimal(input.amountCents), currency: input.currency },
            description: (input.reason ?? "Ticket refund").slice(0, 128),
          },
          {
            provider: "yookassa",
            headers: {
              Authorization: this.authHeader,
              "Idempotence-Key": `refund_${input.providerRef}_${input.amountCents}`,
            },
          },
        );
        if (status < 200 || status >= 300) {
          throw ProviderChargeError.gateway(`YooKassa refund answered with HTTP ${status}`);
        }
      },
      () => ProviderChargeError.unavailable("YooKassa is temporarily unavailable. Please try again."),
    );
  }

  /**
   * YooKassa notifications carry NO signature — a forged POST is trivial.
   * So every event is confirmed with an authenticated GET /payments/{id}:
   * only the status read from the API is trusted, never the webhook body.
   */
  async verifyWebhook(rawBody: Buffer): Promise<ProviderWebhookOutcome> {
    let event: { type?: string; event?: string; object?: { id?: string } };
    try {
      event = JSON.parse(rawBody.toString("utf8")) as typeof event;
    } catch {
      throw ProviderChargeError.invalidWebhook("YooKassa webhook is not valid JSON");
    }
    const type = event.type ?? event.event ?? "";
    const paymentId = event.object?.id;
    if (!paymentId || !type.startsWith("payment.")) {
      throw ProviderChargeError.invalidWebhook("YooKassa webhook has an unexpected shape");
    }

    const { status, data } = await getJson<YooKassaPayment>(
      `${this.config.apiUrl}/payments/${encodeURIComponent(paymentId)}`,
      { provider: "yookassa", headers: { Authorization: this.authHeader } },
    );
    if (status < 200 || status >= 300) {
      throw ProviderChargeError.gateway(`YooKassa confirmation fetch answered with HTTP ${status}`);
    }
    logger.debug({ paymentId, type, confirmed: data.status }, "yookassa webhook confirmed via API");
    return {
      eventId: `${type}:${paymentId}`,
      providerRef: data.id,
      status:
        data.status === "succeeded" || data.paid
          ? "succeeded"
          : data.status === "canceled"
            ? "failed"
            : "pending",
    };
  }

  private mapPayment(payment: YooKassaPayment): ChargeResult {
    if (payment.status === "succeeded" || payment.paid) {
      return { status: "succeeded", providerRef: payment.id };
    }
    if (payment.status === "canceled") {
      const reason = payment.cancellation_details?.reason ?? "general_decline";
      const message = TERMINAL_FAILURES.has(reason)
        ? "The card was declined. Try another card or payment method."
        : "YooKassa could not complete the payment.";
      throw ProviderChargeError.declined(message);
    }
    // pending / waiting_for_capture with redirect confirmation (3-D Secure, SBP).
    if (payment.confirmation?.confirmation_url) {
      return {
        status: "requires_action",
        providerRef: payment.id,
        actionUrl: payment.confirmation.confirmation_url,
      };
    }
    return { status: "pending", providerRef: payment.id };
  }
}
