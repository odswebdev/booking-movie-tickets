import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/services/payments/circuitBreaker.js";
import { postJson } from "../src/services/payments/http.js";
import { MockProvider } from "../src/services/payments/mockProvider.js";
import { PayPalProvider } from "../src/services/payments/paypal.js";
import { StripeProvider } from "../src/services/payments/stripe.js";
import { ProviderChargeError, type ChargeInput, type RefundInput } from "../src/services/payments/types.js";
import { YooKassaProvider } from "../src/services/payments/yookassa.js";

const CARD_INPUT: ChargeInput = {
  idempotencyKey: "pay_test_1",
  bookingId: "bk_1",
  amountCents: 2544,
  currency: "RUB",
  method: "card",
  methodData: {
    kind: "card",
    number: "4242424242424242",
    expiryMonth: "12",
    expiryYear: "2030",
    cvc: "123",
    holder: "Ada Lovelace",
  },
  description: "CineTickets booking TEST-0001",
  returnUrl: "http://localhost:5173/payment-success/bk_1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, data: unknown) {
  return { status, text: async () => JSON.stringify(data) };
}

describe("MockProvider", () => {
  it("settles instantly", async () => {
    const result = await new MockProvider().charge(CARD_INPUT);
    expect(result.status).toBe("succeeded");
    expect(result.providerRef).toContain("pay_test_1");
  });
});

describe("YooKassaProvider", () => {
  const config = { shopId: "shop", secretKey: "secret", apiUrl: "https://yookassa.test" };

  it("maps a succeeded payment and sends the idempotency key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: "yk_1", status: "succeeded", paid: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new YooKassaProvider(config).charge(CARD_INPUT);
    expect(result).toEqual({ status: "succeeded", providerRef: "yk_1" });

    const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(options.headers["Idempotence-Key"]).toBe("pay_test_1");
    expect(options.headers.Authorization).toMatch(/^Basic /);
  });

  it("returns requires_action with the 3DS confirmation URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "yk_2",
          status: "pending",
          confirmation: { type: "redirect", confirmation_url: "https://yookassa.test/3ds/yk_2" },
        }),
      ),
    );
    const result = await new YooKassaProvider(config).charge(CARD_INPUT);
    expect(result.status).toBe("requires_action");
    expect(result.actionUrl).toBe("https://yookassa.test/3ds/yk_2");
  });

  it("maps a canceled payment to a decline (not retryable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "yk_3",
          status: "canceled",
          cancellation_details: { reason: "general_decline" },
        }),
      ),
    );
    const error = await new YooKassaProvider(config).charge(CARD_INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderChargeError);
    expect((error as ProviderChargeError).kind).toBe("declined");
    expect((error as ProviderChargeError).retryable).toBe(false);
  });

  it("confirms webhook events with an authenticated API round-trip, not the body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: "yk_9", status: "succeeded", paid: true }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new YooKassaProvider(config).verifyWebhook(
      Buffer.from(JSON.stringify({ type: "payment.succeeded", object: { id: "yk_9" } })),
    );
    expect(outcome).toEqual({ eventId: "payment.succeeded:yk_9", providerRef: "yk_9", status: "succeeded" });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://yookassa.test/payments/yk_9");
  });

  it("rejects malformed webhook bodies", async () => {
    const error = await new YooKassaProvider(config)
      .verifyWebhook(Buffer.from("not-json"))
      .catch((e: unknown) => e);
    expect((error as ProviderChargeError).kind).toBe("invalid_webhook");
  });
});

describe("StripeProvider", () => {
  const config = { secretKey: "sk_test_123", webhookSecret: "whsec_test", apiUrl: "https://stripe.test" };

  it("confirms a PaymentIntent and maps success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ id: "pi_1", status: "succeeded" }) }),
    );
    const result = await new StripeProvider(config).charge(CARD_INPUT);
    expect(result).toEqual({ status: "succeeded", providerRef: "pi_1" });
  });

  it("passes through 3DS redirect actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          id: "pi_2",
          status: "requires_action",
          next_action: { type: "redirect_to_url", redirect_to_url: { url: "https://hooks.stripe.test/3ds" } },
        }),
      }),
    );
    const result = await new StripeProvider(config).charge(CARD_INPUT);
    expect(result.status).toBe("requires_action");
    expect(result.actionUrl).toBe("https://hooks.stripe.test/3ds");
  });

  it("maps card errors to friendly declines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" },
        }),
      }),
    );
    const error = await new StripeProvider(config).charge(CARD_INPUT).catch((e: unknown) => e);
    expect((error as ProviderChargeError).kind).toBe("declined");
    expect((error as ProviderChargeError).message).toMatch(/Insufficient funds/);
  });

  it("verifies webhook HMAC signatures", async () => {
    const payload = JSON.stringify({
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", status: "succeeded" } },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");

    const outcome = await new StripeProvider(config).verifyWebhook(Buffer.from(payload), {
      "stripe-signature": `t=${t},v1=${v1}`,
    });
    expect(outcome).toEqual({ eventId: "evt_1", providerRef: "pi_1", status: "succeeded" });
  });

  it("rejects forged and stale webhook signatures", async () => {
    const payload = JSON.stringify({
      id: "evt_2",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_2" } },
    });
    const provider = new StripeProvider(config);

    const forged = await provider
      .verifyWebhook(Buffer.from(payload), { "stripe-signature": `t=123,v1=${"0".repeat(64)}` })
      .catch((e: unknown) => e);
    expect((forged as ProviderChargeError).kind).toBe("invalid_webhook");

    const t = Math.floor(Date.now() / 1000) - 3600; // an hour old
    const v1 = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");
    const stale = await provider
      .verifyWebhook(Buffer.from(payload), { "stripe-signature": `t=${t},v1=${v1}` })
      .catch((e: unknown) => e);
    expect((stale as ProviderChargeError).kind).toBe("invalid_webhook");
  });
});

describe("PayPalProvider", () => {
  const config = { clientId: "cid", secret: "sec", apiUrl: "https://paypal.test", webhookId: "" };

  it("creates an order and returns the approval URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
      .mockResolvedValueOnce(
        jsonResponse(201, {
          id: "ORDER-1",
          status: "CREATED",
          links: [{ rel: "approve", href: "https://paypal.test/checkout/ORDER-1" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new PayPalProvider(config).charge({
      ...CARD_INPUT,
      method: "paypal",
      methodData: { kind: "paypal" },
    });
    expect(result.status).toBe("requires_action");
    expect(result.providerRef).toBe("ORDER-1");
    expect(result.actionUrl).toBe("https://paypal.test/checkout/ORDER-1");
  });

  it("captures approved orders from the webhook", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
      .mockResolvedValueOnce(jsonResponse(201, { status: "COMPLETED" }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new PayPalProvider(config).verifyWebhook(
      Buffer.from(
        JSON.stringify({ id: "WH-1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER-1" } }),
      ),
      {},
    );
    expect(outcome.status).toBe("succeeded");
    expect(outcome.providerRef).toBe("ORDER-1");
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold and recovers with a probe", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30 });
    const onOpen = () => new Error("circuit open");
    const fail = () => Promise.reject(new Error("gateway down"));

    await expect(breaker.run(fail, onOpen)).rejects.toThrow("gateway down");
    await expect(breaker.run(fail, onOpen)).rejects.toThrow("gateway down");
    // Open: the function is not even called.
    const probe = vi.fn().mockResolvedValue("ok");
    await expect(breaker.run(probe, onOpen)).rejects.toThrow("circuit open");
    expect(probe).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(breaker.run(probe, onOpen)).resolves.toBe("ok");
    expect(breaker.currentState).toBe("closed");
  });
});

describe("postJson", () => {
  it("retries a network failure once, then surfaces a gateway error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postJson<{ ok: boolean }>("https://psp.test/x", {}, { provider: "test" });
    expect(result.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const error = await postJson("https://psp.test/x", {}, { provider: "test" }).catch((e: unknown) => e);
    expect((error as ProviderChargeError).kind).toBe("gateway");
  });
});

describe("MockProvider refunds", () => {
  it("is a no-op that always succeeds", async () => {
    const input: RefundInput = { providerRef: "mock_pay_1", amountCents: 2544, currency: "RUB" };
    await expect(new MockProvider().refund(input)).resolves.toBeUndefined();
  });
});

describe("YooKassaProvider refunds", () => {
  const config = { shopId: "shop", secretKey: "secret", apiUrl: "https://yookassa.test" };

  it("POSTs the refund with an idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "rf_1", status: "succeeded" }));
    vi.stubGlobal("fetch", fetchMock);

    await new YooKassaProvider(config).refund({ providerRef: "yk_1", amountCents: 2544, currency: "RUB" });

    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://yookassa.test/refunds");
    expect(options.headers["Idempotence-Key"]).toBe("refund_yk_1_2544");
    expect(options.headers.Authorization).toMatch(/^Basic /);
    expect(JSON.parse(options.body)).toEqual({
      payment_id: "yk_1",
      amount: { value: "25.44", currency: "RUB" },
      description: "Ticket refund",
    });
  });

  it("throws on gateway errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: true })));
    await expect(
      new YooKassaProvider(config).refund({ providerRef: "yk_1", amountCents: 2544, currency: "RUB" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("StripeProvider refunds", () => {
  const config = { secretKey: "sk_test_123", webhookSecret: "whsec_test", apiUrl: "https://stripe.test" };

  it("POSTs a form-encoded refund with an idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ id: "re_1" }) });
    vi.stubGlobal("fetch", fetchMock);

    await new StripeProvider(config).refund({ providerRef: "pi_1", amountCents: 2544, currency: "RUB" });

    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://stripe.test/v1/refunds");
    expect(options.headers["Idempotency-Key"]).toBe("refund_pi_1_2544");
    const form = new URLSearchParams(options.body);
    expect(form.get("payment_intent")).toBe("pi_1");
    expect(form.get("amount")).toBe("2544");
  });

  it("maps network failures to gateway errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hangup")));
    await expect(
      new StripeProvider(config).refund({ providerRef: "pi_1", amountCents: 2544, currency: "RUB" }),
    ).rejects.toThrow(/unreachable/);
  });
});

describe("PayPalProvider refunds", () => {
  const config = { clientId: "cid", secret: "sec", apiUrl: "https://paypal.test", webhookId: "" };

  it("refunds the capture with a request id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
      .mockResolvedValueOnce(jsonResponse(201, { status: "COMPLETED" }));
    vi.stubGlobal("fetch", fetchMock);

    await new PayPalProvider(config).refund({ providerRef: "CAP-1", amountCents: 1000, currency: "USD" });

    expect(fetchMock.mock.calls).toHaveLength(2);
    const [url, options] = fetchMock.mock.calls[1] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://paypal.test/v2/payments/captures/CAP-1/refund");
    expect(options.headers["PayPal-Request-Id"]).toBe("refund_CAP-1_1000");
    expect(options.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(options.body)).toEqual({
      amount: { currency_code: "USD", value: "10.00" },
      note_to_payer: "Ticket refund",
    });
  });

  it("throws on gateway errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
      .mockResolvedValueOnce(jsonResponse(422, { name: "UNPROCESSABLE_ENTITY" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PayPalProvider(config).refund({ providerRef: "CAP-1", amountCents: 1000, currency: "USD" }),
    ).rejects.toThrow(/HTTP 422/);
  });
});
