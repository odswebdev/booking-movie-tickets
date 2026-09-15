import { HALL_LAYOUT, seatId as seatKey } from "../../../shared/hall.js";
import {
  CANCELLATION_CUTOFF_MINUTES,
  MAX_SEATS_PER_BOOKING,
  SEAT_HOLD_TTL_SECONDS,
  computeQuote,
} from "../../../shared/pricing.js";
import type {
  Booking,
  CardBrand,
  Movie,
  PaymentMethod,
  BookingSeat,
  QuoteLine,
  Seat,
  SeatMap,
  SeatStatus,
  Showtime,
} from "../../../shared/types.js";
import { getHoldStore, getRepositories, getSeatBus } from "../db/provider.js";
import type { StoredBooking } from "../db/schema.js";
import { ApiError } from "../utils/errors.js";
import { newId, bookingCode } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { minutesBetween } from "../utils/time.js";
import { getCatalog, preSoldSeatIds } from "./catalog.js";
import { resolveDiscount } from "./promotions.js";
import {
  bonusBalanceCents,
  createTicketsForBooking,
  findActivePromotion,
  recordRefund,
  redeemPromotion,
  settleBookingLoyalty,
} from "./loyaltyService.js";
import { audit } from "./auditService.js";
import { providerByName } from "./payments/factory.js";
import { ProviderChargeError } from "./payments/types.js";

/** How long an unpaid booking keeps blocking its seats. */
export const PENDING_BOOKING_TTL_MINUTES = 15;

export interface SeatViewer {
  userId: string | null;
  holdToken: string | null;
}

interface SeatOccupancy {
  status: SeatStatus;
  owner: string | null;
}

/**
 * Seat state is *derived* from bookings and holds rather than stored per seat:
 * there is no way for the two to drift out of sync.
 */
async function buildOccupancy(showtimeId: string, now: Date): Promise<Map<string, SeatOccupancy>> {
  const occupancy = new Map<string, SeatOccupancy>();
  const nowIso = now.toISOString();

  for (const seat of preSoldSeatIds(showtimeId)) {
    occupancy.set(seat, { status: "sold", owner: null });
  }

  const [holds, bookings] = await Promise.all([
    getHoldStore().listActive(showtimeId),
    getRepositories().bookings.findActiveByShowtime(showtimeId, nowIso),
  ]);

  for (const hold of holds) {
    occupancy.set(hold.seatId, { status: "held", owner: hold.userId ?? hold.ownerToken });
  }

  for (const booking of bookings) {
    for (const seat of booking.seats) {
      occupancy.set(seat.seatId, {
        status: booking.status === "confirmed" ? "sold" : "held",
        owner: booking.userId,
      });
    }
  }

  return occupancy;
}

function ownsSeat(entry: SeatOccupancy | undefined, viewer: SeatViewer): boolean {
  if (!entry) return true;
  if (entry.status === "available") return true;
  if (!entry.owner) return false;
  if (viewer.userId && entry.owner === viewer.userId) return true;
  return Boolean(viewer.holdToken && entry.owner === viewer.holdToken);
}

/** Drops expired holds and abandons unpaid bookings past their deadline. */
export async function sweepExpired(now: Date = new Date()): Promise<void> {
  await Promise.all([getHoldStore().sweep(now), getRepositories().bookings.markExpired(now.toISOString())]);
}

export function resolveShowtime(showtimeId: string): Showtime {
  const showtime = getCatalog().showtimeById(showtimeId);
  if (!showtime) throw ApiError.notFound("This showtime no longer exists");
  return showtime;
}

export async function getSeatMap(
  showtimeId: string,
  viewer: SeatViewer,
  now: Date = new Date(),
): Promise<SeatMap> {
  const showtime = resolveShowtime(showtimeId);
  await sweepExpired(now);

  const occupancy = await buildOccupancy(showtimeId, now);
  const seats: Seat[] = [];

  for (const row of HALL_LAYOUT.rows) {
    for (let number = 1; number <= HALL_LAYOUT.columns; number += 1) {
      const id = seatKey(row, number);
      const entry = occupancy.get(id) ?? { status: "available" as SeatStatus, owner: null };
      const seatClass = HALL_LAYOUT.classesByRow[row] ?? "standard";
      seats.push({
        id,
        row,
        number,
        label: id,
        seatClass,
        // Your own held seats stay selectable so you can deselect them.
        status: ownsSeat(entry, viewer) && entry.status === "held" ? "available" : entry.status,
        priceCents: { standard: 1500, premium: 2200, recliner: 3000 }[seatClass],
      });
    }
  }

  const seatsLeft = seats.filter((seat) => seat.status === "available").length;
  return {
    showtimeId,
    hall: showtime.hall,
    layout: HALL_LAYOUT,
    seats,
    capacity: seats.length,
    seatsLeft,
  };
}

async function assertSeatsSelectable(
  showtimeId: string,
  seatIds: string[],
  viewer: SeatViewer,
  now: Date,
): Promise<void> {
  if (seatIds.length === 0) throw ApiError.badRequest("Select at least one seat");
  if (seatIds.length > MAX_SEATS_PER_BOOKING) {
    throw ApiError.badRequest(`You can book at most ${MAX_SEATS_PER_BOOKING} seats per order`);
  }

  const map = await getSeatMap(showtimeId, viewer, now);
  const byId = new Map(map.seats.map((seat) => [seat.id, seat]));
  const unavailable: string[] = [];

  for (const id of seatIds) {
    const seat = byId.get(id);
    if (!seat) {
      unavailable.push(id);
      continue;
    }
    if (seat.status !== "available") unavailable.push(seat.label);
  }

  if (unavailable.length > 0) {
    throw ApiError.seatUnavailable(
      `These seats were just taken: ${unavailable.join(", ")}. Please choose again.`,
      { seats: unavailable },
    );
  }
}

export interface HoldResult {
  holdToken: string;
  expiresAt: string;
  seats: string[];
}

export async function holdSeats(
  showtimeId: string,
  seatIds: string[],
  viewer: SeatViewer,
  now: Date = new Date(),
): Promise<HoldResult> {
  resolveShowtime(showtimeId);
  // Friendly pre-check; the store re-validates atomically below.
  await assertSeatsSelectable(showtimeId, seatIds, viewer, now);

  const holdToken = viewer.holdToken ?? `hld_${newId("t").slice(4)}`;
  const result = await getHoldStore().replace(
    showtimeId,
    { ownerToken: holdToken, userId: viewer.userId },
    seatIds,
    SEAT_HOLD_TTL_SECONDS,
    now,
  );
  if (!result.ok) {
    throw ApiError.seatUnavailable(
      `These seats were just taken: ${result.taken.join(", ")}. Please choose again.`,
      { seats: result.taken },
    );
  }
  await getSeatBus().publish(showtimeId);
  return { holdToken, expiresAt: result.expiresAt, seats: seatIds };
}

export async function releaseHolds(showtimeId: string, viewer: SeatViewer): Promise<void> {
  if (!viewer.holdToken && !viewer.userId) return;
  await getHoldStore().release(showtimeId, { ownerToken: viewer.holdToken, userId: viewer.userId });
  await getSeatBus().publish(showtimeId);
}

async function seatsFromIds(showtimeId: string, seatIds: string[], viewer: SeatViewer, now: Date) {
  const map = await getSeatMap(showtimeId, viewer, now);
  const byId = new Map(map.seats.map((seat) => [seat.id, seat]));
  return seatIds.map((id) => {
    const seat = byId.get(id);
    if (!seat) throw ApiError.badRequest(`Unknown seat ${id}`);
    return {
      seatId: seat.id,
      label: seat.label,
      seatClass: seat.seatClass,
      priceCents: seat.priceCents,
    } satisfies BookingSeat;
  });
}

export interface CreateBookingArgs {
  userId: string;
  showtimeId: string;
  seatIds: string[];
  holdToken?: string;
  promoCode?: string;
  /** Loyalty points to redeem against this order (clamped to the balance). */
  bonusCents?: number;
}

export async function createBooking(args: CreateBookingArgs, now: Date = new Date()): Promise<Booking> {
  const viewer: SeatViewer = { userId: args.userId, holdToken: args.holdToken ?? null };
  const showtime = resolveShowtime(args.showtimeId);
  const catalog = getCatalog();
  const movie = catalog.movieById(showtime.movieId);
  const theater = catalog.theaterById(showtime.theaterId);
  if (!movie || !theater) throw ApiError.notFound("This showtime is not available");

  if (new Date(showtime.startsAt).getTime() - now.getTime() < 15 * 60_000) {
    throw ApiError.badRequest("Online booking for this show has closed");
  }

  await assertSeatsSelectable(args.showtimeId, args.seatIds, viewer, now);

  const seats = await seatsFromIds(args.showtimeId, args.seatIds, viewer, now);
  const lines: QuoteLine[] = seats.map((seat) => ({
    seatId: seat.seatId,
    label: seat.label,
    seatClass: seat.seatClass,
    priceCents: seat.priceCents,
  }));

  // Discounts: promo code, automatic volume discount and the movie's own
  // promotion — the customer always gets the single best offer. Promo codes
  // are resolved against the database (live campaigns, usage limits), with
  // the configured list as a fallback.
  const promo = args.promoCode ? await findActivePromotion(args.promoCode) : null;
  if (args.promoCode && !promo) {
    throw ApiError.validation("That promo code is not valid", [
      { field: "promoCode", message: "Invalid or expired promo code" },
    ]);
  }
  const { percent: offerPercent, promoCode } = resolveDiscount(promo, seats.length);
  const movieDiscount = movie.discountPercent ?? 0;
  const discountPercent = Math.max(offerPercent, movieDiscount);

  // Loyalty points the buyer chose to redeem — never more than the balance.
  const balance = await bonusBalanceCents(args.userId);
  const bonusCents = Math.max(0, Math.min(args.bonusCents ?? 0, balance));

  const quote = computeQuote({
    lines,
    discountPercent,
    promoCode: movieDiscount > offerPercent ? null : promoCode,
    bonusCents,
  });

  // Holds first (atomic), then the booking row (atomic vs concurrent
  // checkouts): either both land or the user gets a clear 409 and retries.
  // A hold left behind by a failed insert simply expires in 5 minutes.
  await holdSeats(args.showtimeId, args.seatIds, viewer, now);

  const stored: StoredBooking = {
    id: newId("bkg"),
    code: bookingCode(),
    userId: args.userId,
    showtimeId: args.showtimeId,
    status: "pending",
    currency: quote.currency,
    seats,
    quote,
    snapshot: {
      movieId: movie.id,
      movieSlug: movie.slug,
      movieTitle: movie.title,
      posterUrl: movie.posterUrl,
      durationMinutes: movie.durationMinutes,
      theaterName: theater.name,
      theaterAddress: theater.address,
      hall: showtime.hall,
      startsAt: showtime.startsAt,
      endsAt: showtime.endsAt,
    },
    timeZone: showtime.timeZone,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_BOOKING_TTL_MINUTES * 60_000).toISOString(),
    cancelledAt: null,
  };

  const created = await getRepositories().bookings.createPending(stored, now.toISOString());
  if (created.status === "seat_taken") {
    throw ApiError.seatUnavailable(
      `These seats were just taken: ${created.seats.join(", ")}. Please choose again.`,
      { seats: created.seats },
    );
  }
  await getSeatBus().publish(args.showtimeId);

  return toBooking(created.booking);
}

/** Live catalog copy of a movie (null once a title leaves the catalogue). */
function catalogMovie(movieId: string): Movie | undefined {
  try {
    return getCatalog().movieById(movieId);
  } catch {
    return undefined;
  }
}

export function toBooking(stored: StoredBooking): Booking {
  return {
    id: stored.id,
    code: stored.code,
    userId: stored.userId,
    showtimeId: stored.showtimeId,
    status: stored.status,
    currency: stored.currency,
    seats: stored.seats,
    quote: stored.quote,
    movie: {
      id: stored.snapshot.movieId,
      slug: stored.snapshot.movieSlug,
      title: stored.snapshot.movieTitle,
      posterUrl: stored.snapshot.posterUrl,
      durationMinutes: stored.snapshot.durationMinutes,
      localized: catalogMovie(stored.snapshot.movieId)?.localized,
      discountPercent: catalogMovie(stored.snapshot.movieId)?.discountPercent ?? 0,
    },
    theaterName: stored.snapshot.theaterName,
    theaterAddress: stored.snapshot.theaterAddress,
    hall: stored.snapshot.hall,
    startsAt: stored.snapshot.startsAt,
    endsAt: stored.snapshot.endsAt,
    timeZone: stored.timeZone,
    phone: stored.phone ?? null,
    payment: stored.payment ?? null,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    cancelledAt: stored.cancelledAt,
  };
}

export async function findStoredBooking(id: string): Promise<StoredBooking | undefined> {
  return getRepositories().bookings.findById(id);
}

export async function getBookingForUser(
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<Booking> {
  await sweepExpired(now);
  const stored = await findStoredBooking(id);
  if (!stored || stored.userId !== userId) throw ApiError.notFound("Ticket not found");
  return toBooking(stored);
}

export type BookingScope = "upcoming" | "history" | "all";

/**
 * Applies (or clears) a promo code on a pending booking and recomputes the
 * quote server side, so the total can never be tampered with from the client.
 */
export async function applyPromo(
  bookingId: string,
  userId: string,
  code: string | null,
): Promise<StoredBooking> {
  const repos = getRepositories();
  const booking = await repos.bookings.findById(bookingId);
  if (!booking || booking.userId !== userId) throw ApiError.notFound("Booking not found");
  if (booking.status !== "pending") {
    throw ApiError.conflict("Promo codes can only be applied before payment");
  }

  const promotion = code ? await findActivePromotion(code) : null;
  if (code && !promotion) {
    throw ApiError.validation("That promo code is not valid", [
      { field: "promoCode", message: "Invalid or expired promo code" },
    ]);
  }

  const movie = getCatalog().movieById(booking.snapshot.movieId);
  const movieDiscount = movie?.discountPercent ?? 0;
  const { percent, promoCode } = resolveDiscount(promotion, booking.seats.length);

  const quote = computeQuote({
    lines: booking.quote.lines,
    discountPercent: Math.max(percent, movieDiscount),
    promoCode: movieDiscount > percent ? null : promoCode,
    // Redeemed points survive a promo edit; the balance is re-checked on pay.
    bonusCents: booking.quote.bonusCents ?? 0,
  });
  const updated = await repos.bookings.updateQuote(bookingId, userId, quote, new Date().toISOString());
  if (updated === "not_found") throw ApiError.notFound("Booking not found");
  if (updated === "not_pending") throw ApiError.conflict("Promo codes can only be applied before payment");
  return updated;
}

export async function listBookingsForUser(
  userId: string,
  scope: BookingScope = "all",
  now: Date = new Date(),
): Promise<Booking[]> {
  await sweepExpired(now);
  const bookings = (await getRepositories().bookings.listByUser(userId))
    .map(toBooking)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  if (scope === "all") return bookings;
  const isPast = (booking: Booking) =>
    booking.status !== "confirmed" || new Date(booking.startsAt).getTime() < now.getTime();

  return scope === "history" ? bookings.filter(isPast) : bookings.filter((booking) => !isPast(booking));
}

export interface RefundResult {
  booking: Booking;
  /**
   * False only when there was no PSP charge to reverse (no succeeded payment
   * on file, or an unknown provider) — the booking is still cancelled and the
   * case is logged for support to reconcile. A PSP *failure* throws instead,
   * leaving the ticket untouched so the visitor can retry.
   */
  refunded: boolean;
}

/**
 * Cancels a confirmed booking and reverses the PSP charge, when there is one.
 * The payment flips to `refunded` only after the PSP confirms; every provider
 * dedups by `refund_<ref>_<amount>`, so a retry after a crash can never
 * double-refund.
 */
export async function refundBooking(
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<RefundResult> {
  await sweepExpired(now);
  const stored = await findStoredBooking(id);
  if (!stored || stored.userId !== userId) throw ApiError.notFound("Ticket not found");
  if (stored.status !== "confirmed") {
    throw ApiError.conflict("Only confirmed tickets can be cancelled");
  }

  const minutesToShow = minutesBetween(now, stored.snapshot.startsAt);
  if (minutesToShow < CANCELLATION_CUTOFF_MINUTES) {
    throw ApiError.conflict(
      `Tickets can only be cancelled up to ${CANCELLATION_CUTOFF_MINUTES / 60} hours before the show`,
    );
  }

  const repos = getRepositories();
  const settled = await repos.payments.findSettledByBooking(id);
  let refunded = false;
  if (settled?.status === "refunded") {
    // A previous attempt reversed the charge but crashed before cancelling.
    refunded = true;
  } else if (settled?.providerRef) {
    const provider = providerByName(settled.provider);
    if (!provider) {
      logger.warn({ bookingId: id, provider: settled.provider }, "refund skipped: unknown payment provider");
    } else {
      try {
        await provider.refund({
          providerRef: settled.providerRef,
          amountCents: settled.amountCents,
          currency: settled.currency,
          reason: `Ticket refund ${stored.code}`,
        });
      } catch (error) {
        if (error instanceof ProviderChargeError) {
          throw ApiError.paymentFailed(
            error.message || "The refund failed. Your ticket is still valid — please try again.",
          );
        }
        throw error;
      }
      await repos.payments.update(settled.id, { status: "refunded", updatedAt: now.toISOString() });
      refunded = true;
    }
  } else {
    logger.warn({ bookingId: id }, "refund skipped: no succeeded payment on file");
  }

  const cancelled = await repos.bookings.cancel(id, userId, now.toISOString());
  if (cancelled === "not_found") throw ApiError.notFound("Ticket not found");
  if (cancelled === "not_confirmed") throw ApiError.conflict("Only confirmed tickets can be cancelled");

  await releaseHolds(stored.showtimeId, { userId, holdToken: null });

  // The money trail (ТЗ §2): one Refund row per reversal, tickets voided.
  await recordRefund({
    bookingId: cancelled.id,
    amountCents: settled?.amountCents ?? cancelled.quote.totalCents,
    currency: cancelled.currency,
    reason: `Ticket refund ${cancelled.code}`,
    provider: settled?.provider ?? null,
  });

  await audit("booking.refunded", { userId, entityId: cancelled.id, meta: { refunded } });

  // Best-effort: the refund email must never break — or delay — the refund itself.
  if (bookingRefundedHandler) {
    await bookingRefundedHandler(cancelled.id).catch((error: unknown) => {
      logger.warn({ err: error, bookingId: cancelled.id }, "refund notification failed");
    });
  }
  return { booking: toBooking(cancelled), refunded };
}

/**
 * Legacy cancellation path — now reverses the charge too (the UI always
 * promised "the payment refunded"). Prefer `refundBooking`, which additionally
 * reports whether money actually moved.
 */
export async function cancelBooking(id: string, userId: string, now: Date = new Date()): Promise<Booking> {
  const { booking } = await refundBooking(id, userId, now);
  return booking;
}

/** Called by the payment service once the PSP settles the charge. */
export async function recordPayment(
  bookingId: string,
  payment: {
    method: PaymentMethod;
    brand: CardBrand | null;
    last4: string | null;
    phoneMasked: string | null;
    provider?: string | null;
  },
): Promise<void> {
  await getRepositories().bookings.recordPayment(bookingId, payment, new Date().toISOString());
}

/**
 * Injected ticket notifier (wired in `createApp`): fired when a booking
 * confirms. Injected — not imported — so the service layer never depends on
 * the queue layer (see `queues/notifications.ts`).
 */
let bookingConfirmedHandler: ((bookingId: string) => Promise<void>) | null = null;

export function onBookingConfirmed(handler: ((bookingId: string) => Promise<void>) | null): void {
  bookingConfirmedHandler = handler;
}

/**
 * Injected refund notifier (wired in `createApp`, same as `onBookingConfirmed`).
 */
let bookingRefundedHandler: ((bookingId: string) => Promise<void>) | null = null;

export function onBookingRefunded(handler: ((bookingId: string) => Promise<void>) | null): void {
  bookingRefundedHandler = handler;
}

export async function confirmBooking(bookingId: string, now: Date = new Date()): Promise<StoredBooking> {
  const repos = getRepositories();
  const stored = await repos.bookings.findById(bookingId);
  if (!stored) throw ApiError.notFound("Booking not found");

  const result = await repos.bookings.confirm(bookingId, now.toISOString(), stored.snapshot.startsAt);
  if (result === "unpayable") {
    throw ApiError.conflict("This booking can no longer be paid (status: expired, cancelled or failed)");
  }
  // Seats are now owned by the booking: the hold is no longer needed.
  await getHoldStore().releaseUser(stored.showtimeId, stored.userId);
  await getSeatBus().publish(stored.showtimeId);

  const settled = await repos.bookings.findById(bookingId);
  if (!settled) throw ApiError.notFound("Booking not found");

  // Per-seat ticket rows (QR) + loyalty: cashback for this order, spend of the
  // redeemed points, and the promo campaign's usage counter. All best-effort —
  // a loyal customer's ticket must not hinge on a counter update.
  await createTicketsForBooking({
    bookingId: settled.id,
    code: settled.code,
    seats: settled.seats.map((seat) => ({
      seatId: seat.seatId,
      label: seat.label,
      seatClass: seat.seatClass,
    })),
  });
  try {
    await settleBookingLoyalty({
      userId: settled.userId,
      bookingId: settled.id,
      totalCents: settled.quote.totalCents,
      bonusSpentCents: settled.quote.bonusCents ?? 0,
    });
    if (settled.quote.promoCode) await redeemPromotion(settled.quote.promoCode, now);
  } catch (error) {
    logger.warn({ err: error, bookingId: settled.id }, "loyalty settlement failed");
  }

  // Best-effort: the ticket email (the sync verify path and the async webhook
  // path both land here) must never break — or delay — the confirmation itself.
  if (bookingConfirmedHandler) {
    await bookingConfirmedHandler(settled.id).catch((error: unknown) => {
      logger.warn({ err: error, bookingId: settled.id }, "ticket notification failed");
    });
  }
  return settled;
}

/**
 * Receipt pre-check for `POST /bookings/:id/receipt`: the booking must belong
 * to the caller and be paid. Returns the account email receipts go to —
 * always the account address, never a caller-supplied one (anti-spam).
 */
export async function assertReceiptable(
  bookingId: string,
  userId: string,
): Promise<{ bookingId: string; to: string }> {
  const stored = await findStoredBooking(bookingId);
  if (!stored || stored.userId !== userId) throw ApiError.notFound("Ticket not found");
  if (stored.status !== "confirmed") {
    throw ApiError.conflict("Receipts are only available for confirmed tickets");
  }
  const user = await getRepositories().users.findById(userId);
  if (!user) throw ApiError.notFound("Account not found");
  return { bookingId: stored.id, to: user.email };
}

/** Lightweight availability counter for listing screens (no seat payload). */
export async function seatAvailability(
  showtimeId: string,
  now: Date = new Date(),
): Promise<{ capacity: number; seatsLeft: number }> {
  const map = await getSeatMap(showtimeId, { userId: null, holdToken: null }, now);
  return { capacity: map.capacity, seatsLeft: map.seatsLeft };
}
