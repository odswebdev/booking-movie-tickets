import { BULK_DISCOUNT_TIERS } from "../../../shared/pricing.js";
import type { Locale, LoyaltySummary, Promotion, Review, ReviewSummary } from "../../../shared/types.js";
import type {
  StoredBonusTransaction,
  StoredPromocode,
  StoredRefund,
  StoredReview,
  StoredTicket,
  StoredUser,
} from "../db/schema.js";
import { getRepositories } from "../db/provider.js";
import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { newId } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { audit } from "./auditService.js";
import { findPromotion as findEnvPromotion, listPromotions } from "./promotions.js";

/**
 * Loyalty & money-adjacent rows (ТЗ §2): promo codes, bonus points, referrals,
 * reviews and the per-seat `Ticket` / `Refund` records that back a booking.
 *
 * Everything here is repository-driven, so it behaves identically on the JSON
 * datastore and on PostgreSQL.
 */

/* --------------------------------------------------------------------------
 * Promo codes (DB-backed, with usage limits — the env list stays the source
 * for the seeded campaigns)
 * ------------------------------------------------------------------------ */

function promoFromStored(stored: StoredPromocode): Promotion {
  return { code: stored.code, percent: stored.percent, description: stored.description };
}

function isPromoLive(stored: StoredPromocode, now: Date): boolean {
  if (!stored.active) return false;
  if (stored.validFrom && now.toISOString() < stored.validFrom) return false;
  if (stored.validTo && now.toISOString() > stored.validTo) return false;
  if (stored.usageLimit > 0 && stored.used >= stored.usageLimit) return false;
  return true;
}

/**
 * Seeds the promo campaigns from `PROMO_CODES` into the database. Idempotent:
 * an existing campaign keeps its usage counter, only the percentage/limits
 * are refreshed from configuration.
 */
export async function seedPromocodes(): Promise<number> {
  const repos = getRepositories();
  const campaigns = listPromotions();
  let seeded = 0;
  for (const promo of campaigns) {
    try {
      await repos.promocodes.upsert({
        id: newId("promo"),
        code: promo.code,
        percent: promo.percent,
        description: promo.description,
        minSeats: 1,
        usageLimit: 0,
        used: 0,
        validFrom: null,
        validTo: null,
        active: true,
      });
      seeded += 1;
    } catch (error) {
      logger.warn({ err: error, code: promo.code }, "promo code seed failed");
    }
  }
  return seeded;
}

/**
 * Resolves a promo code: the database first (live campaigns with limits, or
 * ones an operator added by hand), then the env-configured list as a fallback
 * so a fresh install never rejects a documented code.
 */
export async function findActivePromotion(code: string, now: Date = new Date()): Promise<Promotion | null> {
  const normalized = code.trim().toUpperCase();
  try {
    const stored = await getRepositories().promocodes.findByCode(normalized);
    if (stored) return isPromoLive(stored, now) ? promoFromStored(stored) : null;
  } catch (error) {
    logger.warn({ err: error, code: normalized }, "promo lookup failed — falling back to configuration");
  }
  return findEnvPromotion(normalized);
}

/** Counts one redemption; best-effort (a failed counter must not lose a sale). */
export async function redeemPromotion(code: string, now: Date = new Date()): Promise<void> {
  try {
    await getRepositories().promocodes.redeem(code, now.toISOString());
  } catch (error) {
    logger.warn({ err: error, code }, "promo redemption counter failed");
  }
}

export async function listPromocodes(): Promise<StoredPromocode[]> {
  try {
    return await getRepositories().promocodes.list();
  } catch {
    return [];
  }
}

/** Automatic volume discount tiers, exposed for the checkout summary. */
export function bulkTiers(): typeof BULK_DISCOUNT_TIERS {
  return BULK_DISCOUNT_TIERS;
}

/* --------------------------------------------------------------------------
 * Bonus points
 * ------------------------------------------------------------------------ */

export async function bonusBalanceCents(userId: string): Promise<number> {
  try {
    return await getRepositories().bonus.balanceCents(userId);
  } catch (error) {
    logger.warn({ err: error, userId }, "bonus balance lookup failed");
    return 0;
  }
}

export async function creditBonus(
  userId: string,
  deltaCents: number,
  reason: string,
  bookingId: string | null = null,
): Promise<StoredBonusTransaction> {
  return getRepositories().bonus.append({
    id: newId("bonus"),
    userId,
    delta: Math.round(deltaCents),
    reason,
    bookingId,
    createdAt: new Date().toISOString(),
  });
}

/** Percent of the order total credited back — `BONUS_PERCENT` (default 5%). */
export function bookingBonusCents(totalCents: number): number {
  return Math.round((totalCents * env.BONUS_PERCENT) / 100);
}

/**
 * Called once a booking is paid: spends what the buyer chose to redeem and
 * credits the cashback for the new order. Idempotent per booking.
 */
export async function settleBookingLoyalty(input: {
  userId: string;
  bookingId: string;
  totalCents: number;
  bonusSpentCents: number;
}): Promise<{ earnedCents: number }> {
  const repos = getRepositories();
  if (input.bonusSpentCents > 0) {
    const existing = await repos.bonus.listByUser(input.userId);
    const alreadySpent = existing.some(
      (entry) => entry.bookingId === input.bookingId && entry.reason === "booking_spend",
    );
    if (!alreadySpent) {
      await creditBonus(input.userId, -Math.abs(input.bonusSpentCents), "booking_spend", input.bookingId);
    }
  }

  const earned = bookingBonusCents(input.totalCents);
  if (earned <= 0) return { earnedCents: 0 };

  const alreadyEarned = (await repos.bonus.listByUser(input.userId)).some(
    (entry) => entry.bookingId === input.bookingId && entry.reason === "booking_bonus",
  );
  if (alreadyEarned) return { earnedCents: earned };

  await creditBonus(input.userId, earned, "booking_bonus", input.bookingId);
  return { earnedCents: earned };
}

export async function loyaltySummary(user: StoredUser): Promise<LoyaltySummary> {
  const repos = getRepositories();
  const [transactions, invited, code] = await Promise.all([
    repos.bonus.listByUser(user.id),
    repos.referrals.countByReferrer(user.id),
    ensureReferralCode(user),
  ]);
  const balanceCents = transactions.reduce((sum, entry) => sum + entry.delta, 0);
  const earnedCents = transactions
    .filter((entry) => entry.delta > 0)
    .reduce((sum, entry) => sum + entry.delta, 0);
  const spentCents = Math.abs(
    transactions.filter((entry) => entry.delta < 0).reduce((sum, entry) => sum + entry.delta, 0),
  );
  return {
    balanceCents,
    earnedCents,
    spentCents,
    transactions: transactions.map((entry) => ({
      id: entry.id,
      delta: entry.delta,
      reason: entry.reason,
      bookingId: entry.bookingId,
      createdAt: entry.createdAt,
    })),
    referral: { code, invited },
  };
}

/* --------------------------------------------------------------------------
 * Referrals
 * ------------------------------------------------------------------------ */

function generateReferralCode(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 4)
    .padEnd(4, "x");
  const suffix = newId("ref")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 5)
    .toUpperCase();
  return `${base.toUpperCase()}${suffix}`;
}

/** Returns (and lazily persists) the user's public referral code. */
export async function ensureReferralCode(user: StoredUser): Promise<string> {
  if (user.referralCode) return user.referralCode;
  const code = generateReferralCode(user.name);
  try {
    await getRepositories().users.updateReferralCode?.(user.id, code);
  } catch (error) {
    logger.warn({ err: error, userId: user.id }, "referral code persist failed");
  }
  return code;
}

/**
 * Credits both sides of an invite. Called right after registration; every
 * failure is non-fatal (a signup must never fail because a bonus did).
 */
export async function applyReferral(newUser: StoredUser, code: string): Promise<void> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return;
  try {
    const repos = getRepositories();
    const referrer = await repos.users.findByReferralCode(normalized);
    if (!referrer || referrer.id === newUser.id) return;
    if (newUser.isGuest) return;

    const referral = await repos.referrals.create({
      id: newId("ref"),
      referrerId: referrer.id,
      referredId: newUser.id,
      inviterBonus: env.REFERRAL_INVITER_BONUS_CENTS,
      welcomeBonus: env.REFERRAL_WELCOME_BONUS_CENTS,
      createdAt: new Date().toISOString(),
    });

    if (referral.welcomeBonus > 0) await creditBonus(newUser.id, referral.welcomeBonus, "referral_welcome");
    if (referral.inviterBonus > 0) await creditBonus(referrer.id, referral.inviterBonus, "referral_invite");
    await audit("referral.credited", {
      userId: referrer.id,
      entityId: referral.id,
      meta: { welcomeBonus: referral.welcomeBonus, inviterBonus: referral.inviterBonus },
    });
  } catch (error) {
    logger.warn({ err: error, code: normalized }, "referral application failed");
  }
}

/* --------------------------------------------------------------------------
 * Tickets (per-seat QR records created when a booking confirms)
 * ------------------------------------------------------------------------ */

export async function createTicketsForBooking(input: {
  bookingId: string;
  code: string;
  seats: Array<{ seatId: string; label: string; seatClass: StoredTicket["seatClass"] }>;
}): Promise<StoredTicket[]> {
  const now = new Date().toISOString();
  const tickets: StoredTicket[] = input.seats.map((seat, index) => ({
    id: newId("tkt"),
    bookingId: input.bookingId,
    // Deterministic per booking+seat: re-confirming must not mint new codes.
    qrCode: `CT-${input.code}-${String(index + 1).padStart(2, "0")}`,
    seatLabel: seat.label,
    seatClass: seat.seatClass,
    status: "valid",
    issuedAt: now,
  }));
  try {
    await getRepositories().tickets.createMany(tickets);
  } catch (error) {
    logger.warn({ err: error, bookingId: input.bookingId }, "ticket rows not persisted");
  }
  return tickets;
}

export async function listTickets(bookingId: string): Promise<StoredTicket[]> {
  try {
    return await getRepositories().tickets.listByBooking(bookingId);
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------------
 * Refunds
 * ------------------------------------------------------------------------ */

export async function recordRefund(input: {
  bookingId: string;
  amountCents: number;
  currency: StoredRefund["currency"];
  reason: string;
  provider: string | null;
}): Promise<StoredRefund | null> {
  try {
    const refund = await getRepositories().refunds.create({
      id: newId("rfd"),
      bookingId: input.bookingId,
      amountCents: input.amountCents,
      currency: input.currency,
      reason: input.reason,
      provider: input.provider,
      createdAt: new Date().toISOString(),
    });
    await getRepositories().tickets.markRefunded(input.bookingId);
    return refund;
  } catch (error) {
    logger.warn({ err: error, bookingId: input.bookingId }, "refund row not persisted");
    return null;
  }
}

export async function listRefunds(bookingId: string): Promise<StoredRefund[]> {
  try {
    return await getRepositories().refunds.listByBooking(bookingId);
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------------
 * Reviews
 * ------------------------------------------------------------------------ */

export const REVIEW_MAX_LENGTH = 600;

function toPublicReview(stored: StoredReview): Review {
  return {
    id: stored.id,
    movieId: stored.movieId,
    authorName: stored.authorName,
    rating: stored.rating,
    text: stored.text,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export async function submitReview(input: {
  movieId: string;
  userId: string;
  authorName: string;
  rating: number;
  text: string;
}): Promise<Review> {
  const rating = Math.round(input.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 10) {
    throw ApiError.validation("Give the movie a score from 1 to 10", [
      { field: "rating", message: "Rating must be between 1 and 10" },
    ]);
  }
  const text = input.text.trim();
  if (text.length < 3) {
    throw ApiError.validation("Please write a few words about the movie", [
      { field: "text", message: "Review is too short" },
    ]);
  }
  if (text.length > REVIEW_MAX_LENGTH) {
    throw ApiError.validation("That review is too long", [
      { field: "text", message: `Keep it under ${REVIEW_MAX_LENGTH} characters` },
    ]);
  }

  const now = new Date().toISOString();
  const existing = await getRepositories().reviews.findByMovieAndUser(input.movieId, input.userId);
  const stored = await getRepositories().reviews.upsert({
    id: existing?.id ?? newId("rev"),
    movieId: input.movieId,
    userId: input.userId,
    authorName: input.authorName.slice(0, 40),
    rating,
    text,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  await audit(existing ? "review.updated" : "review.created", {
    userId: input.userId,
    entityId: stored.id,
    meta: { movieId: input.movieId, rating },
  });
  return toPublicReview(stored);
}

export async function movieReviewSummary(
  movieId: string,
  locale: Locale,
  limit = 10,
): Promise<ReviewSummary> {
  const repos = getRepositories();
  try {
    const [aggregate, reviews] = await Promise.all([
      repos.reviews.aggregate(movieId),
      repos.reviews.listByMovie(movieId),
    ]);
    return {
      count: aggregate.count,
      average: aggregate.average,
      items: reviews.slice(0, limit).map(toPublicReview),
      locale,
    };
  } catch (error) {
    logger.warn({ err: error, movieId }, "review summary failed");
    return { count: 0, average: null, items: [], locale };
  }
}

/** True when the user already reviewed the movie (drives the form state). */
export async function findUserReview(movieId: string, userId: string): Promise<Review | null> {
  const stored = await getRepositories().reviews.findByMovieAndUser(movieId, userId);
  return stored ? toPublicReview(stored) : null;
}

/* --------------------------------------------------------------------------
 * GDPR: what erasure or export must know about
 * ------------------------------------------------------------------------ */

export async function deleteLoyaltyForUser(userId: string): Promise<void> {
  const repos = getRepositories();
  await Promise.allSettled([
    repos.bonus.deleteByUser(userId),
    repos.referrals.deleteByUser(userId),
    repos.reviews.deleteByUser(userId),
  ]);
}

export async function exportLoyaltyForUser(userId: string): Promise<{
  bonus: StoredBonusTransaction[];
  reviews: Review[];
}> {
  const repos = getRepositories();
  const [bonus, reviews] = await Promise.all([
    repos.bonus.listByUser(userId).catch(() => []),
    repos.reviews.listByUser(userId).catch(() => []),
  ]);
  return { bonus, reviews: reviews.map(toPublicReview) };
}
