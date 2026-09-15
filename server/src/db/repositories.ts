import type { Quote } from "../../../shared/types.js";
import type {
  OtpPurpose,
  StoredAuditEvent,
  StoredBonusTransaction,
  StoredBooking,
  StoredCatalog,
  StoredOtpCode,
  StoredPayment,
  StoredPromocode,
  StoredReferral,
  StoredRefreshToken,
  StoredRefund,
  StoredReview,
  StoredTicket,
  StoredUser,
  StoredWebhookEvent,
} from "./schema.js";

/**
 * Persistence ports (Repository pattern).
 *
 * Services depend only on these interfaces. Two adapters exist:
 * - JSON (`db/json/`) — zero infrastructure, default when DATABASE_URL is unset;
 * - Prisma/PostgreSQL (`db/prisma/`) — transactions, row locks, unique backstops.
 *
 * Every method documents its atomicity contract; both adapters must honour it.
 */

export interface UserRepository {
  findById(id: string): Promise<StoredUser | undefined>;
  findByEmail(email: string): Promise<StoredUser | undefined>;
  /** Phone verification: a number can only belong to one account. */
  findByPhone(phone: string): Promise<StoredUser | undefined>;
  /** Guest claim / profile edits that must not touch the password hash. */
  updateProfile(user: StoredUser): Promise<void>;
  /** Loyalty: resolve the inviter a signup used a referral code for. */
  findByReferralCode(code: string): Promise<StoredUser | undefined>;
  /** Persists the lazily generated referral code / verified phone number. */
  updateReferralCode(id: string, code: string): Promise<void>;
  setPhoneVerified(id: string, phone: string, verifiedAtIso: string): Promise<void>;
  /** Throws on duplicate email (service maps it to 409). */
  create(user: StoredUser): Promise<StoredUser>;
  /** Hard delete (GDPR erasure). Postgres cascades; the service deletes dependents explicitly for JSON. */
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

export interface SessionRepository {
  findByTokenHash(hash: string): Promise<StoredRefreshToken | undefined>;
  create(entry: StoredRefreshToken): Promise<void>;
  /**
   * Rotation, atomic: revoke the old token and store the new one, linking
   * `replacedBy`. Concurrent rotations of the same token both succeed (each
   * mints its own successor) — the grace window in the service tolerates that.
   */
  rotate(oldHash: string, next: StoredRefreshToken, nowIso: string): Promise<void>;
  /**
   * Theft response, atomic: revoke every live session of the user created at
   * or before `cutoffIso`, plus the rotation descendant (if still live).
   */
  revokeOlderSessions(
    userId: string,
    cutoffIso: string,
    descendantHash: string | null,
    nowIso: string,
  ): Promise<number>;
  revokeByHash(hash: string, nowIso: string): Promise<void>;
  /** Revokes every session of the user (account deletion). Returns the revoked count. */
  deleteByUser(userId: string): Promise<number>;
}

export type CreateBookingResult =
  { status: "ok"; booking: StoredBooking } | { status: "seat_taken"; seats: string[] };

export interface BookingRepository {
  /**
   * Insert, atomic per showtime: fails with `seat_taken` when any seat
   * overlaps a live (pending, unexpired / confirmed) booking by another
   * buyer. The buyer's own pending booking never blocks them — the seat
   * map shows their held seats as re-selectable. Closes the
   * check-then-act race between concurrent checkouts.
   */
  createPending(input: StoredBooking, nowIso: string): Promise<CreateBookingResult>;
  findById(id: string): Promise<StoredBooking | undefined>;
  /** Live bookings (pending unexpired + confirmed) blocking seats of a showtime. */
  findActiveByShowtime(showtimeId: string, nowIso: string): Promise<StoredBooking[]>;
  listByUser(userId: string): Promise<StoredBooking[]>;
  /** pending → confirmed, atomic; already-confirmed is idempotent. */
  confirm(
    id: string,
    nowIso: string,
    settledExpiresAt: string,
  ): Promise<"confirmed" | "already" | "unpayable">;
  cancel(id: string, userId: string, nowIso: string): Promise<StoredBooking | "not_found" | "not_confirmed">;
  markExpired(nowIso: string): Promise<number>;
  updateQuote(
    id: string,
    userId: string,
    quote: Quote,
    nowIso: string,
  ): Promise<StoredBooking | "not_found" | "not_pending">;
  recordPayment(id: string, payment: StoredBooking["payment"], nowIso: string): Promise<void>;
  /** Deletes every booking of the user (account deletion frees their seats). Returns the deleted count. */
  deleteByUser(userId: string): Promise<number>;
  count(): Promise<number>;
}

export type CreatePaymentResult = { status: "ok" } | { status: "live_exists" };

export interface PaymentRepository {
  /**
   * Insert, guarded by a partial unique index on live intents: `live_exists`
   * when the booking already has a `requires_code` intent (the caller then
   * re-reads it instead of double-charging).
   */
  create(payment: StoredPayment): Promise<CreatePaymentResult>;
  findById(id: string): Promise<StoredPayment | undefined>;
  findLiveByBooking(bookingId: string): Promise<StoredPayment | undefined>;
  findByProviderRef(providerRef: string): Promise<StoredPayment | undefined>;
  /**
   * Latest succeeded-or-refunded payment for a booking (the charge holding —
   * or that held — the money). `refunded` short-circuits the PSP call so a
   * retry after a crash never double-refunds.
   */
  findSettledByBooking(bookingId: string): Promise<StoredPayment | undefined>;
  update(id: string, patch: Partial<StoredPayment>): Promise<StoredPayment | undefined>;
  /** Every payment of the given bookings, oldest first (GDPR export). */
  listByBookingIds(bookingIds: string[]): Promise<StoredPayment[]>;
  /** Deletes payments of the given bookings (account deletion). Returns the deleted count. */
  deleteByBookingIds(bookingIds: string[]): Promise<number>;
  count(): Promise<number>;
}

export interface OtpCodeRepository {
  /**
   * Insert, superseding previous live codes for the same (purpose, key):
   * a resend kills the old code atomically with the new insert.
   */
  issue(input: StoredOtpCode): Promise<StoredOtpCode>;
  /** Newest live (unexpired, unconsumed) code for (purpose, key). */
  findLive(purpose: OtpPurpose, key: string, nowIso: string): Promise<StoredOtpCode | undefined>;
  /**
   * Attempts decrement, atomic: succeeds only while the code is live.
   * Returns the remaining attempts, or "gone" when consumed/expired.
   */
  decrement(id: string, nowIso: string): Promise<{ attemptsLeft: number } | "gone">;
  /**
   * Mark consumed, atomic: succeeds only while live AND attempts remain.
   * Closes the double-verify race (two tabs submitting the same code).
   */
  consume(id: string, nowIso: string): Promise<boolean>;
}

export interface WebhookEventRepository {
  /** Insert; `false` when (provider, eventId) was already recorded. */
  insert(event: StoredWebhookEvent): Promise<boolean>;
}

export interface AuditRepository {
  append(event: StoredAuditEvent): Promise<void>;
  /** Newest-first trail for GDPR export and support. */
  listByUser(userId: string): Promise<StoredAuditEvent[]>;
}

/**
 * Catalog storage (ТЗ §2). The catalog service seeds this on an empty
 * database and re-seeds when the bookable window rolls over; every read is a
 * plain query, so an operator can edit showtimes without touching code.
 */
export interface CatalogRepository {
  /** Full snapshot, or `null` when nothing has been seeded yet. */
  load(): Promise<StoredCatalog | null>;
  /** Replaces the snapshot (seed on first boot / window rollover). */
  replace(snapshot: StoredCatalog): Promise<void>;
  countScreens(): Promise<number>;
}

export interface TicketRepository {
  createMany(tickets: StoredTicket[]): Promise<void>;
  listByBooking(bookingId: string): Promise<StoredTicket[]>;
  /** Refund path: every ticket of the booking flips to `refunded`. */
  markRefunded(bookingId: string): Promise<void>;
  count(): Promise<number>;
}

export interface RefundRepository {
  create(refund: StoredRefund): Promise<StoredRefund>;
  listByBooking(bookingId: string): Promise<StoredRefund[]>;
  listByBookingIds(bookingIds: string[]): Promise<StoredRefund[]>;
  deleteByBookingIds(bookingIds: string[]): Promise<number>;
  count(): Promise<number>;
}

export interface PromocodeRepository {
  list(): Promise<StoredPromocode[]>;
  findByCode(code: string): Promise<StoredPromocode | undefined>;
  /** Atomic usage increment; `false` when the limit is already exhausted. */
  redeem(code: string, nowIso: string): Promise<boolean>;
  upsert(promo: StoredPromocode): Promise<void>;
}

export interface BonusRepository {
  balanceCents(userId: string): Promise<number>;
  append(entry: StoredBonusTransaction): Promise<StoredBonusTransaction>;
  listByUser(userId: string): Promise<StoredBonusTransaction[]>;
  deleteByUser(userId: string): Promise<number>;
}

export interface ReferralRepository {
  create(referral: StoredReferral): Promise<StoredReferral>;
  findByReferred(referredId: string): Promise<StoredReferral | undefined>;
  listByReferrer(referrerId: string): Promise<StoredReferral[]>;
  /** Anonymous invite counter for a landing page (no PII). */
  countByReferrer(referrerId: string): Promise<number>;
  deleteByUser(userId: string): Promise<number>;
}

export interface ReviewRepository {
  upsert(review: StoredReview): Promise<StoredReview>;
  findByMovieAndUser(movieId: string, userId: string): Promise<StoredReview | undefined>;
  listByMovie(movieId: string): Promise<StoredReview[]>;
  listByUser(userId: string): Promise<StoredReview[]>;
  aggregate(movieId: string): Promise<{ count: number; average: number | null }>;
  deleteByUser(userId: string): Promise<number>;
}

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  bookings: BookingRepository;
  payments: PaymentRepository;
  otpCodes: OtpCodeRepository;
  webhookEvents: WebhookEventRepository;
  audit: AuditRepository;
  catalog: CatalogRepository;
  tickets: TicketRepository;
  refunds: RefundRepository;
  promocodes: PromocodeRepository;
  bonus: BonusRepository;
  referrals: ReferralRepository;
  reviews: ReviewRepository;
}
