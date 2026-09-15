import type {
  AuditLog as PrismaAuditLog,
  BonusTransaction as PrismaBonusTransaction,
  Booking as PrismaBooking,
  Cinema as PrismaCinema,
  City as PrismaCity,
  Hall as PrismaHall,
  Movie as PrismaMovie,
  OtpCode as PrismaOtpCode,
  Payment as PrismaPayment,
  Promocode as PrismaPromocode,
  Referral as PrismaReferral,
  Refund as PrismaRefund,
  Review as PrismaReview,
  Screening as PrismaScreening,
  Seat as PrismaSeat,
  Session as PrismaSession,
  Ticket as PrismaTicket,
  User as PrismaUser,
  WebhookEvent as PrismaWebhookEvent,
} from "../../generated/prisma/index.js";
import type {
  AuditAction,
  StoredAuditEvent,
  StoredBonusTransaction,
  StoredBooking,
  StoredCinema,
  StoredCity,
  StoredHall,
  StoredMovie,
  StoredOtpCode,
  StoredPayment,
  StoredPromocode,
  StoredReferral,
  StoredRefreshToken,
  StoredRefund,
  StoredReview,
  StoredScreening,
  StoredSeat,
  StoredTicket,
  StoredUser,
  StoredWebhookEvent,
} from "../schema.js";

/**
 * Prisma row <-> Stored* mappers. Dates travel as ISO strings inside the
 * domain (the JSON adapter stores them that way too), so both adapters speak
 * identical types to the services.
 */

const iso = (value: Date): string => value.toISOString();
const date = (value: string): Date => new Date(value);

function asJson<T>(value: unknown): T {
  return value as T;
}

export function toStoredUser(row: PrismaUser): StoredUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.passwordHash,
    phone: row.phone,
    phoneVerifiedAt: row.phoneVerifiedAt ? iso(row.phoneVerifiedAt) : null,
    isGuest: row.isGuest,
    referralCode: row.referralCode,
    createdAt: iso(row.createdAt),
  };
}

export function toStoredSession(row: PrismaSession): StoredRefreshToken {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    replacedBy: row.replacedBy,
    createdAt: iso(row.createdAt),
    userAgent: row.userAgent ?? undefined,
  };
}

export function toStoredBooking(row: PrismaBooking): StoredBooking {
  return {
    id: row.id,
    code: row.code,
    userId: row.userId,
    showtimeId: row.showtimeId,
    status: asJson<StoredBooking["status"]>(row.status),
    currency: asJson<StoredBooking["currency"]>(row.currency),
    seats: asJson<StoredBooking["seats"]>(row.seats),
    quote: asJson<StoredBooking["quote"]>(row.quote),
    snapshot: asJson<StoredBooking["snapshot"]>(row.snapshot),
    phone: row.phone,
    payment: asJson<StoredBooking["payment"]>(row.payment),
    timeZone: row.timeZone ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt),
    cancelledAt: row.cancelledAt ? iso(row.cancelledAt) : null,
  };
}

export function toStoredPayment(row: PrismaPayment): StoredPayment {
  return {
    id: row.id,
    bookingId: row.bookingId,
    method: asJson<StoredPayment["method"]>(row.method),
    status: asJson<StoredPayment["status"]>(row.status),
    amountCents: row.amountCents,
    currency: asJson<StoredPayment["currency"]>(row.currency),
    provider: row.provider,
    providerRef: row.providerRef,
    actionUrl: row.actionUrl,
    cardBrand: asJson<StoredPayment["cardBrand"]>(row.cardBrand),
    cardLast4: row.cardLast4,
    phone: row.phone,
    attemptsLeft: row.attemptsLeft,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt),
    failureReason: row.failureReason ?? undefined,
  };
}

export function toStoredOtpCode(row: PrismaOtpCode): StoredOtpCode {
  return {
    id: row.id,
    userId: row.userId,
    phone: row.phone,
    purpose: asJson<StoredOtpCode["purpose"]>(row.purpose),
    key: row.key,
    codeHash: row.codeHash,
    expiresAt: iso(row.expiresAt),
    attemptsLeft: row.attemptsLeft,
    consumedAt: row.consumedAt ? iso(row.consumedAt) : null,
    createdAt: iso(row.createdAt),
  };
}

export function toStoredWebhookEvent(row: PrismaWebhookEvent): StoredWebhookEvent {
  return {
    id: row.id,
    provider: row.provider,
    eventId: row.eventId,
    status: row.status,
    createdAt: iso(row.createdAt),
  };
}

export function toStoredAuditEvent(row: PrismaAuditLog): StoredAuditEvent {
  return {
    id: row.id,
    at: iso(row.at),
    userId: row.userId,
    action: asJson<AuditAction>(row.action),
    entityId: row.entityId,
    meta: asJson<Record<string, unknown> | null>(row.meta),
  };
}

/* --------------------------------------------------------------------------
 * Catalog
 * ------------------------------------------------------------------------ */

export function toStoredCity(row: PrismaCity): StoredCity {
  return {
    id: row.id,
    slug: row.slug,
    countryCode: row.countryCode,
    currency: asJson<StoredCity["currency"]>(row.currency),
    nameRu: row.nameRu,
    nameEn: row.nameEn,
    lat: row.lat,
    lng: row.lng,
  };
}

export function toStoredCinema(row: PrismaCinema): StoredCinema {
  return {
    id: row.id,
    slug: row.slug,
    cityId: row.cityId,
    nameRu: row.nameRu,
    nameEn: row.nameEn,
    addressRu: row.addressRu,
    addressEn: row.addressEn,
    lat: row.lat,
    lng: row.lng,
    locale: asJson<StoredCinema["locale"]>(row.locale),
  };
}

export function toStoredHall(row: PrismaHall): StoredHall {
  return {
    id: row.id,
    cinemaId: row.cinemaId,
    nameRu: row.nameRu,
    nameEn: row.nameEn,
    format: row.format,
    rows: row.rows,
    columns: row.columns,
    aislesAfter: row.aislesAfter,
    classesByRow: asJson<StoredHall["classesByRow"]>(row.classesByRow),
  };
}

export function toStoredSeat(row: PrismaSeat): StoredSeat {
  return {
    id: row.id,
    hallId: row.hallId,
    row: row.row,
    number: row.number,
    seatClass: asJson<StoredSeat["seatClass"]>(row.seatClass),
    priceDeltaCents: row.priceDeltaCents,
  };
}

export function toStoredMovie(row: PrismaMovie): StoredMovie {
  return {
    id: row.id,
    slug: row.slug,
    titleRu: row.titleRu,
    titleEn: row.titleEn,
    synopsisRu: row.synopsisRu,
    synopsisEn: row.synopsisEn,
    posterUrl: row.posterUrl,
    backdropUrl: row.backdropUrl,
    trailerUrl: row.trailerUrl,
    durationMinutes: row.durationMinutes,
    genresRu: row.genresRu,
    genresEn: row.genresEn,
    ageRating: row.ageRating,
    releaseYear: row.releaseYear,
    releaseDate: row.releaseDate,
    voteAverage: row.voteAverage,
    isNew: row.isNew,
    discountPercent: row.discountPercent,
    badges: row.badges,
    source: asJson<StoredMovie["source"]>(row.source),
  };
}

export function toStoredScreening(row: PrismaScreening): StoredScreening {
  return {
    id: row.id,
    movieId: row.movieId,
    hallId: row.hallId,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    date: row.date,
    time: row.time,
    timeZone: row.timeZone,
    basePriceCents: row.basePriceCents,
    currency: asJson<StoredScreening["currency"]>(row.currency),
  };
}

/* --------------------------------------------------------------------------
 * Tickets, refunds, promo codes, loyalty
 * ------------------------------------------------------------------------ */

export function toStoredTicket(row: PrismaTicket): StoredTicket {
  return {
    id: row.id,
    bookingId: row.bookingId,
    qrCode: row.qrCode,
    seatLabel: row.seatLabel,
    seatClass: asJson<StoredTicket["seatClass"]>(row.seatClass),
    status: asJson<StoredTicket["status"]>(row.status),
    issuedAt: iso(row.issuedAt),
  };
}

export function toStoredRefund(row: PrismaRefund): StoredRefund {
  return {
    id: row.id,
    bookingId: row.bookingId,
    amountCents: row.amountCents,
    currency: asJson<StoredRefund["currency"]>(row.currency),
    reason: row.reason,
    provider: row.provider,
    createdAt: iso(row.createdAt),
  };
}

export function toStoredPromocode(row: PrismaPromocode): StoredPromocode {
  return {
    id: row.id,
    code: row.code,
    percent: row.percent,
    description: row.description,
    minSeats: row.minSeats,
    usageLimit: row.usageLimit,
    used: row.used,
    validFrom: row.validFrom ? iso(row.validFrom) : null,
    validTo: row.validTo ? iso(row.validTo) : null,
    active: row.active,
  };
}

export function toStoredBonusTransaction(row: PrismaBonusTransaction): StoredBonusTransaction {
  return {
    id: row.id,
    userId: row.userId,
    delta: row.delta,
    reason: row.reason,
    bookingId: row.bookingId,
    createdAt: iso(row.createdAt),
  };
}

export function toStoredReferral(row: PrismaReferral): StoredReferral {
  return {
    id: row.id,
    referrerId: row.referrerId,
    referredId: row.referredId,
    inviterBonus: row.inviterBonus,
    welcomeBonus: row.welcomeBonus,
    createdAt: iso(row.createdAt),
  };
}

export function toStoredReview(row: PrismaReview): StoredReview {
  return {
    id: row.id,
    movieId: row.movieId,
    userId: row.userId,
    authorName: row.authorName,
    rating: row.rating,
    text: row.text,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export { date, iso };
