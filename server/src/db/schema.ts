import type {
  BookingSeat,
  BookingStatus,
  CardBrand,
  Currency,
  Locale,
  PaymentMethod,
  PaymentStatus,
  Quote,
  SeatClass,
} from "../../../shared/types.js";

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  /** scrypt digest: `salt:derivedKey`, both hex encoded. Never leaves the server. */
  passwordHash: string;
  /** E.164 number, verified through a `phone_verify` OTP. */
  phone?: string | null;
  phoneVerifiedAt?: string | null;
  /**
   * Guest checkouts create a lightweight account the buyer can later claim.
   * Guests have no password of their own until they set one.
   */
  isGuest?: boolean;
  /** Short public code friends can enter at sign-up (loyalty referrals). */
  referralCode?: string | null;
  createdAt: string;
}

export interface StoredRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  replacedBy: string | null;
  createdAt: string;
  userAgent?: string;
}

export interface StoredBooking {
  id: string;
  code: string;
  userId: string;
  showtimeId: string;
  status: BookingStatus;
  currency: Currency;
  seats: BookingSeat[];
  quote: Quote;
  /** Denormalised snapshot so a ticket stays valid even if the catalog changes. */
  snapshot: {
    movieId: string;
    movieSlug: string;
    movieTitle: string;
    posterUrl: string;
    durationMinutes: number;
    theaterName: string;
    theaterAddress: string;
    hall: string;
    startsAt: string;
    endsAt: string;
  };
  /** Masked phone number the SMS code was sent to. */
  phone?: string | null;
  /** Payment method summary, written once the payment settles. */
  payment?: {
    method: PaymentMethod;
    brand: CardBrand | null;
    last4: string | null;
    phoneMasked: string | null;
    provider?: string | null;
  } | null;
  /** IANA timezone of the cinema this booking belongs to. */
  timeZone?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  cancelledAt: string | null;
}

export interface StoredPayment {
  id: string;
  bookingId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountCents: number;
  currency: Currency;
  /** PSP that settles the charge (mock by default, see PAYMENTS_PROVIDER). */
  provider: string;
  /** PSP-side payment id (YooKassa payment id, Stripe PI id, PayPal order id). */
  providerRef: string | null;
  /** Off-site next step for `requires_action` (3DS / PayPal approval URL). */
  actionUrl: string | null;
  /** Card brand and last 4 digits — the full number is never stored. */
  cardBrand: CardBrand | null;
  cardLast4: string | null;
  /** E.164 phone number the SMS code is sent to. */
  phone: string;
  /** Mirror of the live OtpCode's attempts (the OtpCode row is authoritative). */
  attemptsLeft: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  failureReason?: string;
}

/** One-time code. `payment` rows are keyed by the payment intent id. */
export type OtpPurpose = "payment" | "phone_verify" | "login";

export interface StoredOtpCode {
  id: string;
  userId: string | null;
  phone: string;
  purpose: OtpPurpose;
  /** Owner key: payment intent id for `payment`, phone for the rest. */
  key: string;
  /** argon2id digest. Never leaves the server. */
  codeHash: string;
  expiresAt: string;
  attemptsLeft: number;
  consumedAt: string | null;
  createdAt: string;
}

/** Processed provider webhook events — (provider, eventId) is the idempotency key. */
export interface StoredWebhookEvent {
  id: string;
  provider: string;
  eventId: string;
  status: string;
  createdAt: string;
}

export interface StoredSeatHold {
  id: string;
  showtimeId: string;
  seatId: string;
  ownerToken: string;
  userId: string | null;
  expiresAt: string;
  createdAt: string;
}

export type AuditAction =
  | "auth.register"
  | "auth.login"
  | "auth.magic_link"
  | "auth.guest_created"
  | "auth.guest_claimed"
  | "payment.succeeded"
  | "payment.failed"
  | "booking.refunded"
  | "booking.guest_created"
  | "promo.applied"
  | "referral.credited"
  | "review.created"
  | "review.updated"
  | "account.exported"
  | "account.deleted";

/**
 * Audit trail row. Deliberately has no FK to users and never carries PII in
 * `meta` (ids and amounts only) — the trail stays meaningful (and lawful)
 * after the account itself is erased.
 */
export interface StoredAuditEvent {
  id: string;
  /** ISO-8601 instant. */
  at: string;
  userId: string | null;
  action: AuditAction;
  entityId: string | null;
  meta: Record<string, unknown> | null;
}

/* --------------------------------------------------------------------------
 * Catalog (ТЗ §2: City / Cinema / Hall / Movie / Screening / Seat in the DB).
 * The generator in `services/catalog.ts` produces this shape; the repository
 * persists it so showtimes survive restarts and can be queried/edited.
 * ------------------------------------------------------------------------ */

export interface StoredCity {
  id: string;
  slug: string;
  countryCode: string;
  currency: Currency;
  nameRu: string;
  nameEn: string;
  lat: number;
  lng: number;
}

export interface StoredCinema {
  id: string;
  slug: string;
  cityId: string;
  nameRu: string;
  nameEn: string;
  addressRu: string;
  addressEn: string;
  lat: number;
  lng: number;
  /** Language this cinema is primarily shown in (Moscow ↔ RU, NYC ↔ EN). */
  locale: Locale;
}

export interface StoredHall {
  id: string;
  cinemaId: string;
  nameRu: string;
  nameEn: string;
  format: string;
  rows: number;
  columns: number;
  /** Column indexes after which an aisle is rendered. */
  aislesAfter: number[];
  classesByRow: Record<string, SeatClass>;
}

export interface StoredSeat {
  id: string;
  hallId: string;
  row: string;
  number: number;
  seatClass: SeatClass;
  priceDeltaCents: number;
}

export interface StoredMovie {
  id: string;
  slug: string;
  titleRu: string;
  titleEn: string;
  synopsisRu: string;
  synopsisEn: string;
  posterUrl: string;
  backdropUrl: string | null;
  /** YouTube watch URL for the trailer modal (ТЗ §5). */
  trailerUrl: string | null;
  durationMinutes: number;
  /** Genre labels per language (already localized by the provider). */
  genresRu: string[];
  genresEn: string[];
  ageRating: string;
  releaseYear: number;
  releaseDate: string | null;
  voteAverage: number | null;
  isNew: boolean;
  discountPercent: number;
  badges: string[];
  source: "tmdb" | "local";
}

export interface StoredScreening {
  id: string;
  movieId: string;
  hallId: string;
  /** Pre-computed ISO instants so the DB row is render-ready. */
  startsAt: string;
  endsAt: string;
  /** Cinema-local calendar day and time. */
  date: string;
  time: string;
  timeZone: string;
  basePriceCents: number;
  currency: Currency;
}

export interface StoredCatalog {
  cities: StoredCity[];
  cinemas: StoredCinema[];
  halls: StoredHall[];
  seats: StoredSeat[];
  movies: StoredMovie[];
  screenings: StoredScreening[];
}

/* --------------------------------------------------------------------------
 * Tickets, refunds, promo codes, loyalty (ТЗ §2).
 * ------------------------------------------------------------------------ */

export type StoredTicketStatus = "valid" | "used" | "refunded";

export interface StoredTicket {
  id: string;
  bookingId: string;
  /** Opaque QR payload (the booking QR is generated from this). */
  qrCode: string;
  seatLabel: string;
  seatClass: SeatClass;
  status: StoredTicketStatus;
  issuedAt: string;
}

export interface StoredRefund {
  id: string;
  bookingId: string;
  amountCents: number;
  currency: Currency;
  reason: string;
  /** PSP that reversed the charge (mock | yookassa | stripe | paypal). */
  provider: string | null;
  createdAt: string;
}

export interface StoredPromocode {
  id: string;
  code: string;
  percent: number;
  description: string;
  minSeats: number;
  /** 0 = unlimited. */
  usageLimit: number;
  used: number;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
}

export interface StoredBonusTransaction {
  id: string;
  userId: string;
  /** Positive = accrued, negative = spent. */
  delta: number;
  reason: string;
  /** Booking the accrual belongs to, when there is one. */
  bookingId: string | null;
  createdAt: string;
}

export interface StoredReferral {
  id: string;
  referrerId: string;
  referredId: string;
  /** Bonus credited to the inviter when the invitee signed up. */
  inviterBonus: number;
  /** Welcome bonus credited to the invitee. */
  welcomeBonus: number;
  createdAt: string;
}

export interface StoredReview {
  id: string;
  movieId: string;
  userId: string;
  /** Display name snapshot so a deleted account leaves no PII behind. */
  authorName: string;
  rating: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface DbShape {
  version: number;
  users: StoredUser[];
  refreshTokens: StoredRefreshToken[];
  bookings: StoredBooking[];
  payments: StoredPayment[];
  seatHolds: StoredSeatHold[];
  webhookEvents: StoredWebhookEvent[];
  otpCodes: StoredOtpCode[];
  auditLog: StoredAuditEvent[];
  cities: StoredCity[];
  cinemas: StoredCinema[];
  halls: StoredHall[];
  seats: StoredSeat[];
  movies: StoredMovie[];
  screenings: StoredScreening[];
  tickets: StoredTicket[];
  refunds: StoredRefund[];
  promocodes: StoredPromocode[];
  bonusTransactions: StoredBonusTransaction[];
  referrals: StoredReferral[];
  reviews: StoredReview[];
}

export const emptyDb = (): DbShape => ({
  version: 3,
  users: [],
  refreshTokens: [],
  bookings: [],
  payments: [],
  seatHolds: [],
  webhookEvents: [],
  otpCodes: [],
  auditLog: [],
  cities: [],
  cinemas: [],
  halls: [],
  seats: [],
  movies: [],
  screenings: [],
  tickets: [],
  refunds: [],
  promocodes: [],
  bonusTransactions: [],
  referrals: [],
  reviews: [],
});
