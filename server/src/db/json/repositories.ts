/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the repository interfaces */
import type { Quote } from "../../../../shared/types.js";
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
} from "../schema.js";
import { getStore } from "../store.js";
import type {
  AuditRepository,
  BonusRepository,
  BookingRepository,
  CatalogRepository,
  CreateBookingResult,
  CreatePaymentResult,
  OtpCodeRepository,
  PaymentRepository,
  PromocodeRepository,
  ReferralRepository,
  RefundRepository,
  Repositories,
  ReviewRepository,
  SessionRepository,
  TicketRepository,
  UserRepository,
  WebhookEventRepository,
} from "../repositories.js";

/**
 * JSON-file adapter. Node runs it single-threaded, so every read-modify-write
 * below is naturally atomic — the same contracts the Prisma adapter enforces
 * with transactions, advisory locks and unique indexes.
 */

function isLive(booking: StoredBooking, nowMs: number): boolean {
  if (booking.status === "confirmed") return true;
  if (booking.status !== "pending") return false;
  return new Date(booking.expiresAt).getTime() > nowMs;
}

class JsonUserRepository implements UserRepository {
  async findById(id: string): Promise<StoredUser | undefined> {
    return getStore().db.users.find((user) => user.id === id);
  }

  async findByEmail(email: string): Promise<StoredUser | undefined> {
    return getStore().db.users.find((user) => user.email === email);
  }

  async create(user: StoredUser): Promise<StoredUser> {
    const store = getStore();
    if (store.db.users.some((entry) => entry.email === user.email)) {
      throw Object.assign(new Error("duplicate email"), { code: "DUPLICATE_EMAIL" });
    }
    store.db.users.push(user);
    store.touch();
    return user;
  }

  async findByReferralCode(code: string): Promise<StoredUser | undefined> {
    const normalized = code.trim().toUpperCase();
    return getStore().db.users.find((user) => user.referralCode?.toUpperCase() === normalized);
  }

  async findByPhone(phone: string): Promise<StoredUser | undefined> {
    return getStore().db.users.find((user) => user.phone === phone);
  }

  async updateProfile(user: StoredUser): Promise<void> {
    const store = getStore();
    const index = store.db.users.findIndex((entry) => entry.id === user.id);
    if (index < 0) return;
    store.db.users[index] = { ...store.db.users[index]!, ...user };
    store.touch();
  }

  async updateReferralCode(id: string, code: string): Promise<void> {
    const store = getStore();
    const user = store.db.users.find((entry) => entry.id === id);
    if (!user || user.referralCode) return;
    user.referralCode = code;
    store.touch();
  }

  async setPhoneVerified(id: string, phone: string, verifiedAtIso: string): Promise<void> {
    const store = getStore();
    const user = store.db.users.find((entry) => entry.id === id);
    if (!user) return;
    user.phone = phone;
    user.phoneVerifiedAt = verifiedAtIso;
    store.touch();
  }

  async count(): Promise<number> {
    return getStore().db.users.length;
  }
  async delete(id: string): Promise<void> {
    const store = getStore();
    store.db.users = store.db.users.filter((entry) => entry.id !== id);
    store.touch();
  }
}

class JsonSessionRepository implements SessionRepository {
  async findByTokenHash(hash: string): Promise<StoredRefreshToken | undefined> {
    return getStore().db.refreshTokens.find((entry) => entry.tokenHash === hash);
  }

  async create(entry: StoredRefreshToken): Promise<void> {
    const store = getStore();
    store.db.refreshTokens.push(entry);
    store.touch();
  }

  async rotate(oldHash: string, next: StoredRefreshToken, nowIso: string): Promise<void> {
    const store = getStore();
    const current = store.db.refreshTokens.find((entry) => entry.tokenHash === oldHash);
    if (!current) return;
    current.revokedAt = nowIso;
    current.replacedBy = next.tokenHash;
    store.db.refreshTokens.push(next);
    store.touch();
  }

  async revokeOlderSessions(
    userId: string,
    cutoffIso: string,
    descendantHash: string | null,
    nowIso: string,
  ): Promise<number> {
    const store = getStore();
    const cutoffMs = new Date(cutoffIso).getTime();
    let revoked = 0;
    for (const entry of store.db.refreshTokens) {
      if (entry.userId !== userId || entry.revokedAt) continue;
      const isDescendant = descendantHash !== null && entry.tokenHash === descendantHash;
      if (!isDescendant && new Date(entry.createdAt).getTime() > cutoffMs) continue;
      entry.revokedAt = nowIso;
      revoked += 1;
    }
    if (revoked > 0) store.touch();
    return revoked;
  }

  async revokeByHash(hash: string, nowIso: string): Promise<void> {
    const store = getStore();
    const entry = store.db.refreshTokens.find((candidate) => candidate.tokenHash === hash);
    if (entry && !entry.revokedAt) {
      entry.revokedAt = nowIso;
      store.touch();
    }
  }
  async deleteByUser(userId: string): Promise<number> {
    const store = getStore();
    const before = store.db.refreshTokens.length;
    store.db.refreshTokens = store.db.refreshTokens.filter((entry) => entry.userId !== userId);
    store.touch();
    return before - store.db.refreshTokens.length;
  }
}

class JsonBookingRepository implements BookingRepository {
  async createPending(input: StoredBooking, nowIso: string): Promise<CreateBookingResult> {
    const store = getStore();
    const nowMs = new Date(nowIso).getTime();
    const wanted = new Set(input.seats.map((seat) => seat.seatId));
    const taken: string[] = [];
    for (const booking of store.db.bookings) {
      if (booking.showtimeId !== input.showtimeId || !isLive(booking, nowMs)) continue;
      // The buyer's own pending booking never blocks them: the seat map
      // shows their held seats as re-selectable, and the race guard must
      // not be stricter than the map.
      if (booking.userId === input.userId && booking.status === "pending") continue;
      for (const seat of booking.seats) {
        if (wanted.has(seat.seatId)) taken.push(seat.label);
      }
    }
    if (taken.length > 0) return { status: "seat_taken", seats: taken };
    store.db.bookings.push(input);
    store.touch();
    return { status: "ok", booking: input };
  }

  async findById(id: string): Promise<StoredBooking | undefined> {
    return getStore().db.bookings.find((booking) => booking.id === id);
  }

  async findActiveByShowtime(showtimeId: string, nowIso: string): Promise<StoredBooking[]> {
    const nowMs = new Date(nowIso).getTime();
    return getStore().db.bookings.filter(
      (booking) => booking.showtimeId === showtimeId && isLive(booking, nowMs),
    );
  }

  async listByUser(userId: string): Promise<StoredBooking[]> {
    return getStore().db.bookings.filter((booking) => booking.userId === userId);
  }

  async confirm(
    id: string,
    nowIso: string,
    settledExpiresAt: string,
  ): Promise<"confirmed" | "already" | "unpayable"> {
    const store = getStore();
    const booking = store.db.bookings.find((entry) => entry.id === id);
    if (!booking) return "unpayable";
    if (booking.status === "confirmed") return "already";
    if (booking.status !== "pending") return "unpayable";
    booking.status = "confirmed";
    booking.updatedAt = nowIso;
    booking.expiresAt = settledExpiresAt;
    store.touch();
    return "confirmed";
  }

  async cancel(
    id: string,
    userId: string,
    nowIso: string,
  ): Promise<StoredBooking | "not_found" | "not_confirmed"> {
    const store = getStore();
    const booking = store.db.bookings.find((entry) => entry.id === id);
    if (!booking || booking.userId !== userId) return "not_found";
    if (booking.status !== "confirmed") return "not_confirmed";
    booking.status = "cancelled";
    booking.cancelledAt = nowIso;
    booking.updatedAt = nowIso;
    store.touch();
    return booking;
  }

  async markExpired(nowIso: string): Promise<number> {
    const store = getStore();
    const nowMs = new Date(nowIso).getTime();
    let changed = 0;
    for (const booking of store.db.bookings) {
      if (booking.status === "pending" && new Date(booking.expiresAt).getTime() <= nowMs) {
        booking.status = "expired";
        booking.updatedAt = nowIso;
        changed += 1;
      }
    }
    if (changed > 0) store.touch();
    return changed;
  }

  async updateQuote(
    id: string,
    userId: string,
    quote: Quote,
    nowIso: string,
  ): Promise<StoredBooking | "not_found" | "not_pending"> {
    const store = getStore();
    const booking = store.db.bookings.find((entry) => entry.id === id);
    if (!booking || booking.userId !== userId) return "not_found";
    if (booking.status !== "pending") return "not_pending";
    booking.quote = quote;
    booking.updatedAt = nowIso;
    store.touch();
    return booking;
  }

  async recordPayment(id: string, payment: StoredBooking["payment"], nowIso: string): Promise<void> {
    const store = getStore();
    const booking = store.db.bookings.find((entry) => entry.id === id);
    if (!booking) return;
    booking.payment = payment;
    booking.updatedAt = nowIso;
    store.touch();
  }

  async count(): Promise<number> {
    return getStore().db.bookings.length;
  }
  async deleteByUser(userId: string): Promise<number> {
    const store = getStore();
    const before = store.db.bookings.length;
    store.db.bookings = store.db.bookings.filter((entry) => entry.userId !== userId);
    store.touch();
    return before - store.db.bookings.length;
  }
}

class JsonPaymentRepository implements PaymentRepository {
  async create(payment: StoredPayment): Promise<CreatePaymentResult> {
    const store = getStore();
    const live = store.db.payments.some(
      (entry) => entry.bookingId === payment.bookingId && entry.status === "requires_code",
    );
    if (live) return { status: "live_exists" };
    store.db.payments.push(payment);
    store.touch();
    return { status: "ok" };
  }

  async findById(id: string): Promise<StoredPayment | undefined> {
    return getStore().db.payments.find((payment) => payment.id === id);
  }

  async findLiveByBooking(bookingId: string): Promise<StoredPayment | undefined> {
    return getStore().db.payments.find(
      (payment) => payment.bookingId === bookingId && payment.status === "requires_code",
    );
  }

  async findByProviderRef(providerRef: string): Promise<StoredPayment | undefined> {
    return getStore().db.payments.find((payment) => payment.providerRef === providerRef);
  }

  async findSettledByBooking(bookingId: string): Promise<StoredPayment | undefined> {
    const matches = getStore().db.payments.filter(
      (payment) =>
        payment.bookingId === bookingId && (payment.status === "succeeded" || payment.status === "refunded"),
    );
    return matches[matches.length - 1];
  }

  async update(id: string, patch: Partial<StoredPayment>): Promise<StoredPayment | undefined> {
    const store = getStore();
    const payment = store.db.payments.find((entry) => entry.id === id);
    if (!payment) return undefined;
    Object.assign(payment, patch);
    store.touch();
    return payment;
  }

  async count(): Promise<number> {
    return getStore().db.payments.length;
  }
  async listByBookingIds(bookingIds: string[]): Promise<StoredPayment[]> {
    const wanted = new Set(bookingIds);
    return getStore().db.payments.filter((payment) => wanted.has(payment.bookingId));
  }

  async deleteByBookingIds(bookingIds: string[]): Promise<number> {
    const store = getStore();
    const wanted = new Set(bookingIds);
    const before = store.db.payments.length;
    store.db.payments = store.db.payments.filter((payment) => !wanted.has(payment.bookingId));
    store.touch();
    return before - store.db.payments.length;
  }
}

class JsonWebhookEventRepository implements WebhookEventRepository {
  async insert(event: StoredWebhookEvent): Promise<boolean> {
    const store = getStore();
    const duplicate = store.db.webhookEvents.some(
      (entry) => entry.provider === event.provider && entry.eventId === event.eventId,
    );
    if (duplicate) return false;
    store.db.webhookEvents.push(event);
    store.touch();
    return true;
  }
}

class JsonOtpCodeRepository implements OtpCodeRepository {
  async issue(input: StoredOtpCode): Promise<StoredOtpCode> {
    const store = getStore();
    for (const entry of store.db.otpCodes) {
      if (entry.purpose === input.purpose && entry.key === input.key && !entry.consumedAt) {
        entry.consumedAt = input.createdAt; // superseded by the resend
      }
    }
    store.db.otpCodes.push(input);
    store.touch();
    return input;
  }

  async findLive(purpose: OtpPurpose, key: string, nowIso: string): Promise<StoredOtpCode | undefined> {
    const nowMs = new Date(nowIso).getTime();
    const live = getStore().db.otpCodes.filter(
      (entry) =>
        entry.purpose === purpose &&
        entry.key === key &&
        !entry.consumedAt &&
        new Date(entry.expiresAt).getTime() > nowMs,
    );
    live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return live[0];
  }

  async decrement(id: string, nowIso: string): Promise<{ attemptsLeft: number } | "gone"> {
    const store = getStore();
    const entry = store.db.otpCodes.find((code) => code.id === id);
    if (!entry || entry.consumedAt || new Date(entry.expiresAt).getTime() <= new Date(nowIso).getTime()) {
      return "gone";
    }
    entry.attemptsLeft -= 1;
    store.touch();
    return { attemptsLeft: entry.attemptsLeft };
  }

  async consume(id: string, nowIso: string): Promise<boolean> {
    const store = getStore();
    const entry = store.db.otpCodes.find((code) => code.id === id);
    if (
      !entry ||
      entry.consumedAt ||
      entry.attemptsLeft <= 0 ||
      new Date(entry.expiresAt).getTime() <= new Date(nowIso).getTime()
    ) {
      return false;
    }
    entry.consumedAt = nowIso;
    store.touch();
    return true;
  }
}

class JsonAuditRepository implements AuditRepository {
  async append(event: StoredAuditEvent): Promise<void> {
    const store = getStore();
    store.db.auditLog.push(event);
    store.touch();
  }

  async listByUser(userId: string): Promise<StoredAuditEvent[]> {
    return getStore()
      .db.auditLog.filter((entry) => entry.userId === userId)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
}

/* --------------------------------------------------------------------------
 * Catalog
 * ------------------------------------------------------------------------ */

class JsonCatalogRepository implements CatalogRepository {
  async load(): Promise<StoredCatalog | null> {
    const store = getStore();
    const { movies, cities, cinemas, halls, seats, screenings } = store.db;
    if (movies.length === 0 && screenings.length === 0) return null;
    return {
      cities: [...cities],
      cinemas: [...cinemas],
      halls: [...halls],
      seats: [...seats],
      movies: [...movies],
      screenings: [...screenings],
    };
  }

  async replace(snapshot: StoredCatalog): Promise<void> {
    const store = getStore();
    store.db.cities = [...snapshot.cities];
    store.db.cinemas = [...snapshot.cinemas];
    store.db.halls = [...snapshot.halls];
    store.db.seats = [...snapshot.seats];
    store.db.movies = [...snapshot.movies];
    store.db.screenings = [...snapshot.screenings];
    store.touch();
  }

  async countScreens(): Promise<number> {
    return getStore().db.screenings.length;
  }
}

/* --------------------------------------------------------------------------
 * Tickets & refunds
 * ------------------------------------------------------------------------ */

class JsonTicketRepository implements TicketRepository {
  async createMany(tickets: StoredTicket[]): Promise<void> {
    if (tickets.length === 0) return;
    const store = getStore();
    const bookingId = tickets[0]?.bookingId;
    // Idempotency: a re-confirm must not duplicate the same booking's tickets.
    if (bookingId && store.db.tickets.some((entry) => entry.bookingId === bookingId)) return;
    store.db.tickets.push(...tickets);
    store.touch();
  }

  async listByBooking(bookingId: string): Promise<StoredTicket[]> {
    return getStore().db.tickets.filter((entry) => entry.bookingId === bookingId);
  }

  async markRefunded(bookingId: string): Promise<void> {
    const store = getStore();
    for (const ticket of store.db.tickets) {
      if (ticket.bookingId === bookingId) ticket.status = "refunded";
    }
    store.touch();
  }

  async count(): Promise<number> {
    return getStore().db.tickets.length;
  }
}

class JsonRefundRepository implements RefundRepository {
  async create(refund: StoredRefund): Promise<StoredRefund> {
    const store = getStore();
    store.db.refunds.push(refund);
    store.touch();
    return refund;
  }

  async listByBooking(bookingId: string): Promise<StoredRefund[]> {
    return getStore()
      .db.refunds.filter((entry) => entry.bookingId === bookingId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listByBookingIds(bookingIds: string[]): Promise<StoredRefund[]> {
    const ids = new Set(bookingIds);
    return getStore()
      .db.refunds.filter((entry) => ids.has(entry.bookingId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteByBookingIds(bookingIds: string[]): Promise<number> {
    const store = getStore();
    const ids = new Set(bookingIds);
    const before = store.db.refunds.length;
    store.db.refunds = store.db.refunds.filter((entry) => !ids.has(entry.bookingId));
    const removed = before - store.db.refunds.length;
    if (removed > 0) store.touch();
    return removed;
  }

  async count(): Promise<number> {
    return getStore().db.refunds.length;
  }
}

/* --------------------------------------------------------------------------
 * Promo codes, bonuses, referrals, reviews
 * ------------------------------------------------------------------------ */

class JsonPromocodeRepository implements PromocodeRepository {
  async list(): Promise<StoredPromocode[]> {
    return [...getStore().db.promocodes];
  }

  async findByCode(code: string): Promise<StoredPromocode | undefined> {
    const normalized = code.trim().toUpperCase();
    return getStore().db.promocodes.find((entry) => entry.code === normalized);
  }

  async redeem(code: string, nowIso: string): Promise<boolean> {
    const store = getStore();
    const normalized = code.trim().toUpperCase();
    const promo = store.db.promocodes.find((entry) => entry.code === normalized);
    if (!promo || !promo.active) return false;
    if (promo.validFrom && nowIso < promo.validFrom) return false;
    if (promo.validTo && nowIso > promo.validTo) return false;
    if (promo.usageLimit > 0 && promo.used >= promo.usageLimit) return false;
    promo.used += 1;
    store.touch();
    return true;
  }

  async upsert(promo: StoredPromocode): Promise<void> {
    const store = getStore();
    const index = store.db.promocodes.findIndex((entry) => entry.code === promo.code);
    if (index >= 0) {
      const current = store.db.promocodes[index]!;
      // Seeding must never reset the usage counter of a live campaign.
      store.db.promocodes[index] = { ...promo, used: Math.max(promo.used, current.used) };
    } else {
      store.db.promocodes.push(promo);
    }
    store.touch();
  }
}

class JsonBonusRepository implements BonusRepository {
  async balanceCents(userId: string): Promise<number> {
    return getStore()
      .db.bonusTransactions.filter((entry) => entry.userId === userId)
      .reduce((sum, entry) => sum + entry.delta, 0);
  }

  async append(entry: StoredBonusTransaction): Promise<StoredBonusTransaction> {
    const store = getStore();
    store.db.bonusTransactions.push(entry);
    store.touch();
    return entry;
  }

  async listByUser(userId: string): Promise<StoredBonusTransaction[]> {
    return getStore()
      .db.bonusTransactions.filter((entry) => entry.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteByUser(userId: string): Promise<number> {
    const store = getStore();
    const before = store.db.bonusTransactions.length;
    store.db.bonusTransactions = store.db.bonusTransactions.filter((entry) => entry.userId !== userId);
    const removed = before - store.db.bonusTransactions.length;
    if (removed > 0) store.touch();
    return removed;
  }
}

class JsonReferralRepository implements ReferralRepository {
  async create(referral: StoredReferral): Promise<StoredReferral> {
    const store = getStore();
    if (!store.db.referrals.some((entry) => entry.referredId === referral.referredId)) {
      store.db.referrals.push(referral);
      store.touch();
    }
    return referral;
  }

  async findByReferred(referredId: string): Promise<StoredReferral | undefined> {
    return getStore().db.referrals.find((entry) => entry.referredId === referredId);
  }

  async listByReferrer(referrerId: string): Promise<StoredReferral[]> {
    return getStore().db.referrals.filter((entry) => entry.referrerId === referrerId);
  }

  async countByReferrer(referrerId: string): Promise<number> {
    return (await this.listByReferrer(referrerId)).length;
  }

  async deleteByUser(userId: string): Promise<number> {
    const store = getStore();
    const before = store.db.referrals.length;
    store.db.referrals = store.db.referrals.filter(
      (entry) => entry.referrerId !== userId && entry.referredId !== userId,
    );
    const removed = before - store.db.referrals.length;
    if (removed > 0) store.touch();
    return removed;
  }
}

class JsonReviewRepository implements ReviewRepository {
  async upsert(review: StoredReview): Promise<StoredReview> {
    const store = getStore();
    const index = store.db.reviews.findIndex(
      (entry) => entry.movieId === review.movieId && entry.userId === review.userId,
    );
    if (index >= 0) {
      store.db.reviews[index] = review;
    } else {
      store.db.reviews.push(review);
    }
    store.touch();
    return review;
  }

  async findByMovieAndUser(movieId: string, userId: string): Promise<StoredReview | undefined> {
    return getStore().db.reviews.find((entry) => entry.movieId === movieId && entry.userId === userId);
  }

  async listByMovie(movieId: string): Promise<StoredReview[]> {
    return getStore()
      .db.reviews.filter((entry) => entry.movieId === movieId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listByUser(userId: string): Promise<StoredReview[]> {
    return getStore().db.reviews.filter((entry) => entry.userId === userId);
  }

  async aggregate(movieId: string): Promise<{ count: number; average: number | null }> {
    const reviews = await this.listByMovie(movieId);
    if (reviews.length === 0) return { count: 0, average: null };
    const average = reviews.reduce((sum, entry) => sum + entry.rating, 0) / reviews.length;
    return { count: reviews.length, average: Math.round(average * 10) / 10 };
  }

  async deleteByUser(userId: string): Promise<number> {
    const store = getStore();
    const before = store.db.reviews.length;
    store.db.reviews = store.db.reviews.filter((entry) => entry.userId !== userId);
    const removed = before - store.db.reviews.length;
    if (removed > 0) store.touch();
    return removed;
  }
}

export function createJsonRepositories(): Repositories {
  return {
    users: new JsonUserRepository(),
    sessions: new JsonSessionRepository(),
    bookings: new JsonBookingRepository(),
    payments: new JsonPaymentRepository(),
    otpCodes: new JsonOtpCodeRepository(),
    webhookEvents: new JsonWebhookEventRepository(),
    audit: new JsonAuditRepository(),
    catalog: new JsonCatalogRepository(),
    tickets: new JsonTicketRepository(),
    refunds: new JsonRefundRepository(),
    promocodes: new JsonPromocodeRepository(),
    bonus: new JsonBonusRepository(),
    referrals: new JsonReferralRepository(),
    reviews: new JsonReviewRepository(),
  };
}

/** Detects the duplicate-email signal without importing Prisma error types. */
export function isDuplicateEmail(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "DUPLICATE_EMAIL";
}
