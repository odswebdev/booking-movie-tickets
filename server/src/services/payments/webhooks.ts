import { getRepositories } from "../../db/provider.js";
import { logger } from "../../utils/logger.js";
import { maskPhoneForDisplay } from "../smsService.js";
import { audit } from "../auditService.js";
import { confirmBooking, findStoredBooking, recordPayment } from "../bookingService.js";
import type { PaymentProviderName, ProviderWebhookOutcome } from "./types.js";

export type WebhookApplyResult =
  | { outcome: "confirmed"; bookingId: string }
  | { outcome: "failed"; bookingId: string }
  | { outcome: "pending"; bookingId: string }
  | { outcome: "already_processed" }
  | { outcome: "ignored"; reason: string };

/**
 * Applies a *verified* provider event.
 *
 * Idempotency: the (provider, eventId) pair is recorded before any mutation —
 * a redelivered event returns `already_processed` without touching money twice.
 * Unknown provider refs are acknowledged but ignored (a retry would not help).
 */
export async function applyProviderWebhook(
  provider: PaymentProviderName,
  event: ProviderWebhookOutcome,
  now: Date = new Date(),
): Promise<WebhookApplyResult> {
  const repos = getRepositories();
  const nowIso = now.toISOString();

  const inserted = await repos.webhookEvents.insert({
    id: `${provider}:${event.eventId}`,
    provider,
    eventId: event.eventId,
    status: event.status,
    createdAt: nowIso,
  });
  if (!inserted) {
    logger.info({ provider, eventId: event.eventId }, "webhook event already processed");
    return { outcome: "already_processed" };
  }

  const payment = await repos.payments.findByProviderRef(event.providerRef);
  if (!payment) {
    logger.warn({ provider, eventId: event.eventId }, "webhook for an unknown payment");
    return { outcome: "ignored", reason: "unknown payment" };
  }

  if (event.status === "pending") {
    return { outcome: "pending", bookingId: payment.bookingId };
  }

  if (event.status === "failed") {
    if (payment.status !== "succeeded") {
      await repos.payments.update(payment.id, {
        status: "failed",
        failureReason: "provider_declined",
        updatedAt: nowIso,
      });
    }
    return { outcome: "failed", bookingId: payment.bookingId };
  }

  // succeeded
  if (payment.status === "succeeded") {
    return { outcome: "already_processed" };
  }
  const booking = await findStoredBooking(payment.bookingId);
  if (!booking) {
    return { outcome: "ignored", reason: "booking gone" };
  }
  if (booking.status !== "pending") {
    // Paid twice (e.g. the user confirmed in two tabs): the booking is already
    // settled — record the PSP reference and let support reconcile the refund.
    await repos.payments.update(payment.id, { status: "succeeded", updatedAt: nowIso });
    logger.warn(
      { provider, providerRef: event.providerRef, bookingId: booking.id },
      "duplicate PSP capture for a settled booking",
    );
    return { outcome: "already_processed" };
  }

  await confirmBooking(booking.id, now);
  await recordPayment(booking.id, {
    method: payment.method,
    brand: payment.cardBrand,
    last4: payment.cardLast4,
    phoneMasked: maskPhoneForDisplay(payment.phone),
    provider,
  });
  await repos.payments.update(payment.id, { status: "succeeded", updatedAt: nowIso });
  await audit("payment.succeeded", {
    userId: booking.userId,
    entityId: payment.id,
    meta: { bookingId: booking.id, via: "webhook", provider },
  });

  logger.info(
    { provider, providerRef: event.providerRef, bookingId: booking.id },
    "booking confirmed via provider webhook",
  );
  return { outcome: "confirmed", bookingId: booking.id };
}
