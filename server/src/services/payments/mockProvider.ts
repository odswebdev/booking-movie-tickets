/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the PaymentProvider interface */
import { newId } from "../../utils/ids.js";
import type {
  ChargeInput,
  ChargeResult,
  PaymentProvider,
  PaymentProviderName,
  ProviderWebhookOutcome,
  RefundInput,
} from "./types.js";

/**
 * Demo PSP: every charge succeeds instantly, refunds are no-ops.
 * Used when no provider credentials are configured (local dev, CI).
 * Declined-test-card behaviour is enforced earlier, at intent creation.
 */
export class MockProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "mock";

  async charge(input: ChargeInput): Promise<ChargeResult> {
    return { status: "succeeded", providerRef: `mock_${input.idempotencyKey}` };
  }

  async refund(_input: RefundInput): Promise<void> {
    // Nothing to settle against.
  }

  async verifyWebhook(rawBody: Buffer): Promise<ProviderWebhookOutcome> {
    const event = JSON.parse(rawBody.toString("utf8")) as {
      eventId?: string;
      providerRef?: string;
      status?: ProviderWebhookOutcome["status"];
    };
    return {
      eventId: event.eventId ?? newId("evt"),
      providerRef: event.providerRef ?? "",
      status: event.status ?? "succeeded",
    };
  }
}
