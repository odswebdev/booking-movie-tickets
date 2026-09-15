import { getRepositories } from "../db/provider.js";
import { logger } from "../utils/logger.js";
import { notificationFailures } from "../utils/metrics.js";
import { enqueueRefundEmail, enqueueTicketEmail } from "./queueService.js";

/**
 * Fires when a booking confirms (wired via `onBookingConfirmed` in `createApp`,
 * so both the sync verify path and the async webhook path are covered).
 * Never throws: a notification failure must not fail the payment.
 */
export async function notifyTicketReady(bookingId: string): Promise<void> {
  try {
    const repos = getRepositories();
    const booking = await repos.bookings.findById(bookingId);
    const user = booking ? await repos.users.findById(booking.userId) : undefined;
    if (!booking || !user) {
      logger.warn({ bookingId }, "ticket notification skipped: booking or user not found");
      return;
    }
    await enqueueTicketEmail(booking.id, user.email);
  } catch (error) {
    notificationFailures.inc({ kind: "ticket" });
    logger.error({ err: error, bookingId }, "ticket notification failed");
  }
}

/**
 * Fires when a booking is refunded (wired via `onBookingRefunded`).
 * Never throws, same as the ticket notification.
 */
export async function notifyRefundIssued(bookingId: string): Promise<void> {
  try {
    const repos = getRepositories();
    const booking = await repos.bookings.findById(bookingId);
    const user = booking ? await repos.users.findById(booking.userId) : undefined;
    if (!booking || !user) {
      logger.warn({ bookingId }, "refund notification skipped: booking or user not found");
      return;
    }
    await enqueueRefundEmail(booking.id, user.email);
  } catch (error) {
    notificationFailures.inc({ kind: "refund" });
    logger.error({ err: error, bookingId }, "refund notification failed");
  }
}
