import { Prisma } from "../../generated/prisma/index.js";
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
import { getPrisma } from "./client.js";
import {
  date,
  toStoredAuditEvent,
  toStoredBonusTransaction,
  toStoredBooking,
  toStoredCinema,
  toStoredCity,
  toStoredHall,
  toStoredMovie,
  toStoredOtpCode,
  toStoredPayment,
  toStoredPromocode,
  toStoredReferral,
  toStoredRefund,
  toStoredReview,
  toStoredScreening,
  toStoredSeat,
  toStoredSession,
  toStoredTicket,
  toStoredUser,
} from "./mappers.js";

/** Prisma error code for unique-constraint violations. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

class PrismaUserRepository implements UserRepository {
  async findById(id: string): Promise<StoredUser | undefined> {
    const row = await getPrisma().user.findUnique({ where: { id } });
    return row ? toStoredUser(row) : undefined;
  }

  async findByEmail(email: string): Promise<StoredUser | undefined> {
    const row = await getPrisma().user.findUnique({ where: { email } });
    return row ? toStoredUser(row) : undefined;
  }

  async create(user: StoredUser): Promise<StoredUser> {
    try {
      const row = await getPrisma().user.create({
        data: {
          id: user.id,
          name: user.name,
          email: user.email,
          passwordHash: user.passwordHash,
          phone: user.phone ?? null,
          phoneVerifiedAt: user.phoneVerifiedAt ? date(user.phoneVerifiedAt) : null,
          isGuest: user.isGuest ?? false,
          referralCode: user.referralCode ?? null,
          createdAt: date(user.createdAt),
        },
      });
      return toStoredUser(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw Object.assign(new Error("duplicate email"), { code: "DUPLICATE_EMAIL" });
      }
      throw error;
    }
  }

  async findByReferralCode(code: string): Promise<StoredUser | undefined> {
    const row = await getPrisma().user.findUnique({ where: { referralCode: code.trim().toUpperCase() } });
    return row ? toStoredUser(row) : undefined;
  }

  async findByPhone(phone: string): Promise<StoredUser | undefined> {
    const row = await getPrisma().user.findUnique({ where: { phone } });
    return row ? toStoredUser(row) : undefined;
  }

  async updateProfile(user: StoredUser): Promise<void> {
    await getPrisma().user.updateMany({
      where: { id: user.id },
      data: {
        name: user.name,
        email: user.email,
        passwordHash: user.passwordHash,
        phone: user.phone ?? null,
        phoneVerifiedAt: user.phoneVerifiedAt ? date(user.phoneVerifiedAt) : null,
        isGuest: user.isGuest ?? false,
        referralCode: user.referralCode ?? null,
      },
    });
  }

  async updateReferralCode(id: string, code: string): Promise<void> {
    await getPrisma().user.updateMany({
      where: { id, referralCode: null },
      data: { referralCode: code },
    });
  }

  async setPhoneVerified(id: string, phone: string, verifiedAtIso: string): Promise<void> {
    await getPrisma().user.update({
      where: { id },
      data: { phone, phoneVerifiedAt: date(verifiedAtIso) },
    });
  }

  async count(): Promise<number> {
    return getPrisma().user.count();
  }
  async delete(id: string): Promise<void> {
    // Sessions, bookings and payments cascade (see schema onDelete).
    try {
      await getPrisma().user.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return;
      throw error;
    }
  }
}

class PrismaSessionRepository implements SessionRepository {
  async findByTokenHash(hash: string): Promise<StoredRefreshToken | undefined> {
    const row = await getPrisma().session.findUnique({ where: { tokenHash: hash } });
    return row ? toStoredSession(row) : undefined;
  }

  async create(entry: StoredRefreshToken): Promise<void> {
    await getPrisma().session.create({
      data: {
        id: entry.id,
        userId: entry.userId,
        tokenHash: entry.tokenHash,
        expiresAt: date(entry.expiresAt),
        createdAt: date(entry.createdAt),
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  async rotate(oldHash: string, next: StoredRefreshToken, nowIso: string): Promise<void> {
    await getPrisma().$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { tokenHash: oldHash },
        data: { revokedAt: date(nowIso), replacedBy: next.tokenHash },
      });
      await tx.session.create({
        data: {
          id: next.id,
          userId: next.userId,
          tokenHash: next.tokenHash,
          expiresAt: date(next.expiresAt),
          createdAt: date(next.createdAt),
          userAgent: next.userAgent ?? null,
        },
      });
    });
  }

  async revokeOlderSessions(
    userId: string,
    cutoffIso: string,
    descendantHash: string | null,
    nowIso: string,
  ): Promise<number> {
    const result = await getPrisma().session.updateMany({
      where: {
        userId,
        revokedAt: null,
        OR: [
          { createdAt: { lte: date(cutoffIso) } },
          ...(descendantHash ? [{ tokenHash: descendantHash }] : []),
        ],
      },
      data: { revokedAt: date(nowIso) },
    });
    return result.count;
  }

  async revokeByHash(hash: string, nowIso: string): Promise<void> {
    await getPrisma().session.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: date(nowIso) },
    });
  }
  async deleteByUser(userId: string): Promise<number> {
    const result = await getPrisma().session.deleteMany({ where: { userId } });
    return result.count;
  }
}

class PrismaBookingRepository implements BookingRepository {
  async createPending(input: StoredBooking, nowIso: string): Promise<CreateBookingResult> {
    return getPrisma().$transaction(async (tx) => {
      // Serialises concurrent checkouts for the same showtime; different
      // showtimes never block each other. Released at COMMIT/ROLLBACK.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.showtimeId}))`;

      const active = await tx.booking.findMany({
        where: {
          showtimeId: input.showtimeId,
          OR: [{ status: "confirmed" }, { status: "pending", expiresAt: { gt: date(nowIso) } }],
        },
      });
      const wanted = new Set(input.seats.map((seat) => seat.seatId));
      const taken: string[] = [];
      for (const row of active) {
        // The buyer's own pending booking never blocks them (same rule as
        // the JSON adapter and the seat map).
        if (row.userId === input.userId && row.status === "pending") continue;
        for (const seat of toStoredBooking(row).seats) {
          if (wanted.has(seat.seatId)) taken.push(seat.label);
        }
      }
      if (taken.length > 0) return { status: "seat_taken", seats: taken };

      const row = await tx.booking.create({
        data: {
          id: input.id,
          code: input.code,
          userId: input.userId,
          showtimeId: input.showtimeId,
          status: input.status,
          currency: input.currency,
          seats: input.seats as unknown as Prisma.InputJsonValue,
          quote: input.quote as unknown as Prisma.InputJsonValue,
          snapshot: input.snapshot,
          timeZone: input.timeZone ?? null,
          createdAt: date(input.createdAt),
          updatedAt: date(input.updatedAt),
          expiresAt: date(input.expiresAt),
        },
      });
      return { status: "ok", booking: toStoredBooking(row) };
    });
  }

  async findById(id: string): Promise<StoredBooking | undefined> {
    const row = await getPrisma().booking.findUnique({ where: { id } });
    return row ? toStoredBooking(row) : undefined;
  }

  async findActiveByShowtime(showtimeId: string, nowIso: string): Promise<StoredBooking[]> {
    const rows = await getPrisma().booking.findMany({
      where: {
        showtimeId,
        OR: [{ status: "confirmed" }, { status: "pending", expiresAt: { gt: date(nowIso) } }],
      },
    });
    return rows.map(toStoredBooking);
  }

  async listByUser(userId: string): Promise<StoredBooking[]> {
    const rows = await getPrisma().booking.findMany({ where: { userId } });
    return rows.map(toStoredBooking);
  }

  async confirm(
    id: string,
    nowIso: string,
    settledExpiresAt: string,
  ): Promise<"confirmed" | "already" | "unpayable"> {
    // Optimistic transition: exactly one concurrent confirmer wins.
    const result = await getPrisma().booking.updateMany({
      where: { id, status: "pending" },
      data: { status: "confirmed", updatedAt: date(nowIso), expiresAt: date(settledExpiresAt) },
    });
    if (result.count === 1) return "confirmed";
    const current = await getPrisma().booking.findUnique({ where: { id } });
    if (current?.status === "confirmed") return "already";
    return "unpayable";
  }

  async cancel(
    id: string,
    userId: string,
    nowIso: string,
  ): Promise<StoredBooking | "not_found" | "not_confirmed"> {
    const result = await getPrisma().booking.updateMany({
      where: { id, userId, status: "confirmed" },
      data: { status: "cancelled", cancelledAt: date(nowIso), updatedAt: date(nowIso) },
    });
    if (result.count === 1) {
      const row = await getPrisma().booking.findUnique({ where: { id } });
      return row ? toStoredBooking(row) : "not_found";
    }
    const current = await getPrisma().booking.findUnique({ where: { id } });
    if (!current || current.userId !== userId) return "not_found";
    return "not_confirmed";
  }

  async markExpired(nowIso: string): Promise<number> {
    const result = await getPrisma().booking.updateMany({
      where: { status: "pending", expiresAt: { lte: date(nowIso) } },
      data: { status: "expired", updatedAt: date(nowIso) },
    });
    return result.count;
  }

  async updateQuote(
    id: string,
    userId: string,
    quote: Quote,
    nowIso: string,
  ): Promise<StoredBooking | "not_found" | "not_pending"> {
    const result = await getPrisma().booking.updateMany({
      where: { id, userId, status: "pending" },
      data: { quote: quote as unknown as Prisma.InputJsonValue, updatedAt: date(nowIso) },
    });
    if (result.count === 1) {
      const row = await getPrisma().booking.findUnique({ where: { id } });
      return row ? toStoredBooking(row) : "not_found";
    }
    const current = await getPrisma().booking.findUnique({ where: { id } });
    if (!current || current.userId !== userId) return "not_found";
    return "not_pending";
  }

  async recordPayment(id: string, payment: StoredBooking["payment"], nowIso: string): Promise<void> {
    await getPrisma().booking.updateMany({
      where: { id },
      data: {
        payment: (payment ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        updatedAt: date(nowIso),
      },
    });
  }

  async count(): Promise<number> {
    return getPrisma().booking.count();
  }
  async deleteByUser(userId: string): Promise<number> {
    const result = await getPrisma().booking.deleteMany({ where: { userId } });
    return result.count;
  }
}

class PrismaPaymentRepository implements PaymentRepository {
  async create(payment: StoredPayment): Promise<CreatePaymentResult> {
    try {
      await getPrisma().payment.create({
        data: {
          id: payment.id,
          bookingId: payment.bookingId,
          method: payment.method,
          status: payment.status,
          amountCents: payment.amountCents,
          currency: payment.currency,
          provider: payment.provider,
          providerRef: payment.providerRef,
          actionUrl: payment.actionUrl,
          cardBrand: payment.cardBrand,
          cardLast4: payment.cardLast4,
          phone: payment.phone,
          attemptsLeft: payment.attemptsLeft,
          createdAt: date(payment.createdAt),
          updatedAt: date(payment.updatedAt),
          expiresAt: date(payment.expiresAt),
        },
      });
      return { status: "ok" };
    } catch (error) {
      // Partial unique index on live intents: a concurrent create won the race.
      if (isUniqueViolation(error)) return { status: "live_exists" };
      throw error;
    }
  }

  async findById(id: string): Promise<StoredPayment | undefined> {
    const row = await getPrisma().payment.findUnique({ where: { id } });
    return row ? toStoredPayment(row) : undefined;
  }

  async findLiveByBooking(bookingId: string): Promise<StoredPayment | undefined> {
    const row = await getPrisma().payment.findFirst({ where: { bookingId, status: "requires_code" } });
    return row ? toStoredPayment(row) : undefined;
  }

  async findByProviderRef(providerRef: string): Promise<StoredPayment | undefined> {
    const row = await getPrisma().payment.findUnique({ where: { providerRef } });
    return row ? toStoredPayment(row) : undefined;
  }

  async findSettledByBooking(bookingId: string): Promise<StoredPayment | undefined> {
    const row = await getPrisma().payment.findFirst({
      where: { bookingId, status: { in: ["succeeded", "refunded"] } },
      orderBy: { createdAt: "desc" },
    });
    return row ? toStoredPayment(row) : undefined;
  }

  async update(id: string, patch: Partial<StoredPayment>): Promise<StoredPayment | undefined> {
    try {
      const row = await getPrisma().payment.update({
        where: { id },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.providerRef !== undefined ? { providerRef: patch.providerRef } : {}),
          ...(patch.actionUrl !== undefined ? { actionUrl: patch.actionUrl } : {}),
          ...(patch.attemptsLeft !== undefined ? { attemptsLeft: patch.attemptsLeft } : {}),
          ...(patch.expiresAt !== undefined ? { expiresAt: date(patch.expiresAt) } : {}),
          ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason ?? null } : {}),
          ...(patch.updatedAt !== undefined ? { updatedAt: date(patch.updatedAt) } : {}),
        },
      });
      return toStoredPayment(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return undefined;
      throw error;
    }
  }

  async count(): Promise<number> {
    return getPrisma().payment.count();
  }
  async listByBookingIds(bookingIds: string[]): Promise<StoredPayment[]> {
    if (bookingIds.length === 0) return [];
    const rows = await getPrisma().payment.findMany({
      where: { bookingId: { in: bookingIds } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toStoredPayment);
  }

  async deleteByBookingIds(bookingIds: string[]): Promise<number> {
    if (bookingIds.length === 0) return 0;
    const result = await getPrisma().payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
    return result.count;
  }
}

class PrismaWebhookEventRepository implements WebhookEventRepository {
  async insert(event: StoredWebhookEvent): Promise<boolean> {
    try {
      await getPrisma().webhookEvent.create({
        data: {
          id: event.id,
          provider: event.provider,
          eventId: event.eventId,
          status: event.status,
          createdAt: date(event.createdAt),
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

class PrismaOtpCodeRepository implements OtpCodeRepository {
  async issue(input: StoredOtpCode): Promise<StoredOtpCode> {
    const row = await getPrisma().$transaction(async (tx) => {
      await tx.otpCode.updateMany({
        where: { purpose: input.purpose, key: input.key, consumedAt: null },
        data: { consumedAt: date(input.createdAt) },
      });
      return tx.otpCode.create({
        data: {
          id: input.id,
          userId: input.userId,
          phone: input.phone,
          purpose: input.purpose,
          key: input.key,
          codeHash: input.codeHash,
          expiresAt: date(input.expiresAt),
          attemptsLeft: input.attemptsLeft,
          createdAt: date(input.createdAt),
        },
      });
    });
    return toStoredOtpCode(row);
  }

  async findLive(purpose: OtpPurpose, key: string, nowIso: string): Promise<StoredOtpCode | undefined> {
    const row = await getPrisma().otpCode.findFirst({
      where: { purpose, key, consumedAt: null, expiresAt: { gt: date(nowIso) } },
      orderBy: { createdAt: "desc" },
    });
    return row ? toStoredOtpCode(row) : undefined;
  }

  async decrement(id: string, nowIso: string): Promise<{ attemptsLeft: number } | "gone"> {
    const result = await getPrisma().otpCode.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: date(nowIso) } },
      data: { attemptsLeft: { decrement: 1 } },
    });
    if (result.count !== 1) return "gone";
    const row = await getPrisma().otpCode.findUnique({ where: { id } });
    return { attemptsLeft: row?.attemptsLeft ?? 0 };
  }

  async consume(id: string, nowIso: string): Promise<boolean> {
    const result = await getPrisma().otpCode.updateMany({
      where: { id, consumedAt: null, attemptsLeft: { gt: 0 }, expiresAt: { gt: date(nowIso) } },
      data: { consumedAt: date(nowIso) },
    });
    return result.count === 1;
  }
}

class PrismaAuditRepository implements AuditRepository {
  async append(event: StoredAuditEvent): Promise<void> {
    await getPrisma().auditLog.create({
      data: {
        id: event.id,
        at: date(event.at),
        userId: event.userId,
        action: event.action,
        entityId: event.entityId,
        // Round-trip: guarantees JSON-safe content for the JSONB column.
        meta: event.meta ? (JSON.parse(JSON.stringify(event.meta)) as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async listByUser(userId: string): Promise<StoredAuditEvent[]> {
    const rows = await getPrisma().auditLog.findMany({ where: { userId }, orderBy: { at: "desc" } });
    return rows.map(toStoredAuditEvent);
  }
}

/* --------------------------------------------------------------------------
 * Catalog
 * ------------------------------------------------------------------------ */

class PrismaCatalogRepository implements CatalogRepository {
  async load(): Promise<StoredCatalog | null> {
    const prisma = getPrisma();
    const screenings = await prisma.screening.count();
    if (screenings === 0) return null;
    const [cities, cinemas, halls, seats, movies, rows] = await Promise.all([
      prisma.city.findMany(),
      prisma.cinema.findMany(),
      prisma.hall.findMany(),
      prisma.seat.findMany(),
      prisma.movie.findMany(),
      prisma.screening.findMany(),
    ]);
    return {
      cities: cities.map(toStoredCity),
      cinemas: cinemas.map(toStoredCinema),
      halls: halls.map(toStoredHall),
      seats: seats.map(toStoredSeat),
      movies: movies.map(toStoredMovie),
      screenings: rows.map(toStoredScreening),
    };
  }

  async replace(snapshot: StoredCatalog): Promise<void> {
    const prisma = getPrisma();
    await prisma.$transaction(async (tx) => {
      // Order matters: children first on delete, parents first on insert.
      await tx.screening.deleteMany();
      await tx.seat.deleteMany();
      await tx.hall.deleteMany();
      await tx.cinema.deleteMany();
      await tx.city.deleteMany();
      await tx.movie.deleteMany();

      if (snapshot.cities.length > 0) await tx.city.createMany({ data: snapshot.cities });
      if (snapshot.cinemas.length > 0) {
        await tx.cinema.createMany({
          data: snapshot.cinemas.map((cinema) => ({ ...cinema })),
        });
      }
      if (snapshot.halls.length > 0) {
        await tx.hall.createMany({
          data: snapshot.halls.map((hall) => ({
            ...hall,
            classesByRow: hall.classesByRow,
          })),
        });
      }
      if (snapshot.seats.length > 0) {
        // Chunked: a movie theatre can hold thousands of seat rows.
        for (let index = 0; index < snapshot.seats.length; index += 1000) {
          await tx.seat.createMany({ data: snapshot.seats.slice(index, index + 1000) });
        }
      }
      if (snapshot.movies.length > 0) await tx.movie.createMany({ data: snapshot.movies });
      if (snapshot.screenings.length > 0) {
        await tx.screening.createMany({
          data: snapshot.screenings.map((screening) => ({
            ...screening,
            startsAt: date(screening.startsAt),
            endsAt: date(screening.endsAt),
          })),
        });
      }
    });
  }

  async countScreens(): Promise<number> {
    return getPrisma().screening.count();
  }
}

/* --------------------------------------------------------------------------
 * Tickets & refunds
 * ------------------------------------------------------------------------ */

class PrismaTicketRepository implements TicketRepository {
  async createMany(tickets: StoredTicket[]): Promise<void> {
    if (tickets.length === 0) return;
    const bookingId = tickets[0]?.bookingId;
    if (!bookingId) return;
    // Idempotency: the unique qrCode index rejects duplicates of the same
    // booking's tickets; skip the whole batch when they already exist.
    const existing = await getPrisma().ticket.count({ where: { bookingId } });
    if (existing > 0) return;
    try {
      await getPrisma().ticket.createMany({
        data: tickets.map((ticket) => ({ ...ticket, issuedAt: date(ticket.issuedAt) })),
      });
    } catch (error) {
      if (isUniqueViolation(error)) return; // concurrent confirm won the race
      throw error;
    }
  }

  async listByBooking(bookingId: string): Promise<StoredTicket[]> {
    const rows = await getPrisma().ticket.findMany({ where: { bookingId }, orderBy: { seatLabel: "asc" } });
    return rows.map(toStoredTicket);
  }

  async markRefunded(bookingId: string): Promise<void> {
    await getPrisma().ticket.updateMany({ where: { bookingId }, data: { status: "refunded" } });
  }

  async count(): Promise<number> {
    return getPrisma().ticket.count();
  }
}

class PrismaRefundRepository implements RefundRepository {
  async create(refund: StoredRefund): Promise<StoredRefund> {
    const row = await getPrisma().refund.create({
      data: {
        id: refund.id,
        bookingId: refund.bookingId,
        amountCents: refund.amountCents,
        currency: refund.currency,
        reason: refund.reason,
        provider: refund.provider,
        createdAt: date(refund.createdAt),
      },
    });
    return toStoredRefund(row);
  }

  async listByBooking(bookingId: string): Promise<StoredRefund[]> {
    const rows = await getPrisma().refund.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } });
    return rows.map(toStoredRefund);
  }

  async listByBookingIds(bookingIds: string[]): Promise<StoredRefund[]> {
    if (bookingIds.length === 0) return [];
    const rows = await getPrisma().refund.findMany({
      where: { bookingId: { in: bookingIds } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toStoredRefund);
  }

  async deleteByBookingIds(bookingIds: string[]): Promise<number> {
    if (bookingIds.length === 0) return 0;
    const result = await getPrisma().refund.deleteMany({ where: { bookingId: { in: bookingIds } } });
    return result.count;
  }

  async count(): Promise<number> {
    return getPrisma().refund.count();
  }
}

/* --------------------------------------------------------------------------
 * Promo codes, bonuses, referrals, reviews
 * ------------------------------------------------------------------------ */

class PrismaPromocodeRepository implements PromocodeRepository {
  async list(): Promise<StoredPromocode[]> {
    return (await getPrisma().promocode.findMany({ orderBy: { code: "asc" } })).map(toStoredPromocode);
  }

  async findByCode(code: string): Promise<StoredPromocode | undefined> {
    const row = await getPrisma().promocode.findUnique({ where: { code: code.trim().toUpperCase() } });
    return row ? toStoredPromocode(row) : undefined;
  }

  async redeem(code: string, nowIso: string): Promise<boolean> {
    // Atomic: the increment only lands while the campaign is live and unused.
    // The usage cap compares the stored counter against the stored limit, so
    // the whole check runs inside one UPDATE (no read-modify-write race).
    const result = await getPrisma().$executeRaw`
      UPDATE promocodes
         SET used = used + 1
       WHERE code = ${code.trim().toUpperCase()}
         AND active = true
         AND (valid_from IS NULL OR valid_from <= ${date(nowIso)})
         AND (valid_to   IS NULL OR valid_to   >= ${date(nowIso)})
         AND (usage_limit = 0 OR used < usage_limit)
    `;
    return result === 1;
  }

  async upsert(promo: StoredPromocode): Promise<void> {
    const data = {
      percent: promo.percent,
      description: promo.description,
      minSeats: promo.minSeats,
      usageLimit: promo.usageLimit,
      validFrom: promo.validFrom ? date(promo.validFrom) : null,
      validTo: promo.validTo ? date(promo.validTo) : null,
      active: promo.active,
    };
    await getPrisma().promocode.upsert({
      where: { code: promo.code },
      // Seeding must never reset the usage counter of a live campaign.
      update: { ...data },
      create: { id: promo.id, code: promo.code, used: promo.used, ...data },
    });
  }
}

class PrismaBonusRepository implements BonusRepository {
  async balanceCents(userId: string): Promise<number> {
    const result = await getPrisma().bonusTransaction.aggregate({
      where: { userId },
      _sum: { delta: true },
    });
    return result._sum.delta ?? 0;
  }

  async append(entry: StoredBonusTransaction): Promise<StoredBonusTransaction> {
    const row = await getPrisma().bonusTransaction.create({
      data: {
        id: entry.id,
        userId: entry.userId,
        delta: entry.delta,
        reason: entry.reason,
        bookingId: entry.bookingId,
        createdAt: date(entry.createdAt),
      },
    });
    return toStoredBonusTransaction(row);
  }

  async listByUser(userId: string): Promise<StoredBonusTransaction[]> {
    const rows = await getPrisma().bonusTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toStoredBonusTransaction);
  }

  async deleteByUser(userId: string): Promise<number> {
    const result = await getPrisma().bonusTransaction.deleteMany({ where: { userId } });
    return result.count;
  }
}

class PrismaReferralRepository implements ReferralRepository {
  async create(referral: StoredReferral): Promise<StoredReferral> {
    try {
      const row = await getPrisma().referral.create({
        data: {
          id: referral.id,
          referrerId: referral.referrerId,
          referredId: referral.referredId,
          inviterBonus: referral.inviterBonus,
          welcomeBonus: referral.welcomeBonus,
          createdAt: date(referral.createdAt),
        },
      });
      return toStoredReferral(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findByReferred(referral.referredId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async findByReferred(referredId: string): Promise<StoredReferral | undefined> {
    const row = await getPrisma().referral.findUnique({ where: { referredId } });
    return row ? toStoredReferral(row) : undefined;
  }

  async listByReferrer(referrerId: string): Promise<StoredReferral[]> {
    const rows = await getPrisma().referral.findMany({
      where: { referrerId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toStoredReferral);
  }

  async countByReferrer(referrerId: string): Promise<number> {
    return getPrisma().referral.count({ where: { referrerId } });
  }

  async deleteByUser(userId: string): Promise<number> {
    // Cascades cover the FK relations; this keeps the JSON/PG contracts equal.
    const rows = await getPrisma().referral.deleteMany({
      where: { OR: [{ referrerId: userId }, { referredId: userId }] },
    });
    return rows.count;
  }
}

class PrismaReviewRepository implements ReviewRepository {
  async upsert(review: StoredReview): Promise<StoredReview> {
    const row = await getPrisma().review.upsert({
      where: { movieId_userId: { movieId: review.movieId, userId: review.userId } },
      update: {
        rating: review.rating,
        text: review.text,
        authorName: review.authorName,
        updatedAt: date(review.updatedAt),
      },
      create: {
        id: review.id,
        movieId: review.movieId,
        userId: review.userId,
        authorName: review.authorName,
        rating: review.rating,
        text: review.text,
        createdAt: date(review.createdAt),
        updatedAt: date(review.updatedAt),
      },
    });
    return toStoredReview(row);
  }

  async findByMovieAndUser(movieId: string, userId: string): Promise<StoredReview | undefined> {
    const row = await getPrisma().review.findUnique({ where: { movieId_userId: { movieId, userId } } });
    return row ? toStoredReview(row) : undefined;
  }

  async listByMovie(movieId: string): Promise<StoredReview[]> {
    const rows = await getPrisma().review.findMany({
      where: { movieId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toStoredReview);
  }

  async listByUser(userId: string): Promise<StoredReview[]> {
    const rows = await getPrisma().review.findMany({ where: { userId } });
    return rows.map(toStoredReview);
  }

  async aggregate(movieId: string): Promise<{ count: number; average: number | null }> {
    const result = await getPrisma().review.aggregate({
      where: { movieId },
      _count: { _all: true },
      _avg: { rating: true },
    });
    const average = result._avg.rating;
    return {
      count: result._count._all,
      average: average === null ? null : Math.round(average * 10) / 10,
    };
  }

  async deleteByUser(userId: string): Promise<number> {
    const result = await getPrisma().review.deleteMany({ where: { userId } });
    return result.count;
  }
}

export function createPrismaRepositories(): Repositories {
  return {
    users: new PrismaUserRepository(),
    sessions: new PrismaSessionRepository(),
    bookings: new PrismaBookingRepository(),
    payments: new PrismaPaymentRepository(),
    otpCodes: new PrismaOtpCodeRepository(),
    webhookEvents: new PrismaWebhookEventRepository(),
    audit: new PrismaAuditRepository(),
    catalog: new PrismaCatalogRepository(),
    tickets: new PrismaTicketRepository(),
    refunds: new PrismaRefundRepository(),
    promocodes: new PrismaPromocodeRepository(),
    bonus: new PrismaBonusRepository(),
    referrals: new PrismaReferralRepository(),
    reviews: new PrismaReviewRepository(),
  };
}
