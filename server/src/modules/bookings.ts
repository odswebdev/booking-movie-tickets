import { Router } from "express";
import { z } from "zod";
import { createBookingSchema, promoCodeSchema } from "../../../shared/schemas.js";
import {
  applyPromo,
  assertReceiptable,
  cancelBooking,
  refundBooking,
  createBooking,
  getBookingForUser,
  listBookingsForUser,
  toBooking,
} from "../services/bookingService.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { enqueueReceiptEmail } from "../queues/queueService.js";
import { listTickets } from "../services/loyaltyService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { routeParam } from "../utils/http.js";

export const bookingsRouter: Router = Router();

bookingsRouter.use(requireAuth);

const listQuerySchema = z.object({
  scope: z.enum(["upcoming", "history", "all"]).default("all"),
});

bookingsRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { scope } = req.query as z.infer<typeof listQuerySchema>;
    res.json({ items: await listBookingsForUser(req.auth!.userId, scope) });
  }),
);

bookingsRouter.post(
  "/",
  validate(createBookingSchema),
  asyncHandler(async (req, res) => {
    const { showtimeId, seatIds, holdToken, promoCode, bonusCents } = req.body as z.infer<
      typeof createBookingSchema
    >;
    const booking = await createBooking({
      userId: req.auth!.userId,
      showtimeId,
      seatIds,
      holdToken,
      promoCode,
      bonusCents,
    });
    res.status(201).json({ booking });
  }),
);

bookingsRouter.get(
  "/:bookingId",
  asyncHandler(async (req, res) => {
    res.json({ booking: await getBookingForUser(routeParam(req, "bookingId"), req.auth!.userId) });
  }),
);

/** Per-seat tickets (QR) of a confirmed booking (ТЗ §2: Ticket). */
bookingsRouter.get(
  "/:bookingId/tickets",
  asyncHandler(async (req, res) => {
    const bookingId = routeParam(req, "bookingId");
    // Ownership check first — tickets are only visible to the buyer.
    await getBookingForUser(bookingId, req.auth!.userId);
    const items = await listTickets(bookingId);
    res.json({
      items: items.map((ticket) => ({
        id: ticket.id,
        bookingId: ticket.bookingId,
        qrCode: ticket.qrCode,
        seatLabel: ticket.seatLabel,
        seatClass: ticket.seatClass,
        status: ticket.status,
        issuedAt: ticket.issuedAt,
      })),
    });
  }),
);

/** Applies a promo code to a pending booking (re-priced on the server). */
bookingsRouter.post(
  "/:bookingId/promo",
  validate(promoCodeSchema),
  asyncHandler(async (req, res) => {
    const { code } = req.body as z.infer<typeof promoCodeSchema>;
    const booking = await applyPromo(routeParam(req, "bookingId"), req.auth!.userId, code);
    res.json({ booking: toBooking(booking) });
  }),
);

/** Removes the promo code and falls back to automatic discounts only. */
bookingsRouter.delete(
  "/:bookingId/promo",
  asyncHandler(async (req, res) => {
    const booking = await applyPromo(routeParam(req, "bookingId"), req.auth!.userId, null);
    res.json({ booking: toBooking(booking) });
  }),
);

bookingsRouter.post(
  "/:bookingId/cancel",
  asyncHandler(async (req, res) => {
    res.json({ booking: await cancelBooking(routeParam(req, "bookingId"), req.auth!.userId) });
  }),
);

/**
 * Cancels a confirmed booking and reverses the PSP charge. `refunded` is false
 * only when there was no charge to reverse (logged for support) — a PSP
 * *failure* answers 402 and leaves the ticket untouched.
 */
bookingsRouter.post(
  "/:bookingId/refund",
  asyncHandler(async (req, res) => {
    const { booking, refunded } = await refundBooking(routeParam(req, "bookingId"), req.auth!.userId);
    res.json({ booking, refunded });
  }),
);

/**
 * Re-sends the PDF receipt to the account email (202: accepted, the worker —
 * or the inline pipeline — delivers it).
 */
bookingsRouter.post(
  "/:bookingId/receipt",
  asyncHandler(async (req, res) => {
    const receipt = await assertReceiptable(routeParam(req, "bookingId"), req.auth!.userId);
    await enqueueReceiptEmail(receipt.bookingId, receipt.to);
    res.status(202).json({ queued: true });
  }),
);
