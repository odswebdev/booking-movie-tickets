/**
 * Domain types shared by the API and the web client.
 * This module must stay dependency-free so both sides can import it as-is.
 */

export type Currency = "USD" | "RUB";

export type Locale = "en" | "ru";

/** Translated copies of user facing catalog content. */
export interface LocalizedText {
  title?: string;
  synopsis?: string;
}

export type SeatClass = "standard" | "premium" | "recliner";

export type SeatStatus = "available" | "held" | "sold";

export interface Movie {
  id: string;
  slug: string;
  title: string;
  synopsis: string;
  posterUrl: string;
  backdropUrl: string | null;
  /** YouTube watch URL for the trailer modal (ТЗ §5); null when unavailable. */
  trailerUrl?: string | null;
  durationMinutes: number;
  genres: string[];
  rating: "G" | "PG" | "PG-13" | "R";
  releaseYear: number;
  /** ISO release date, used for the "New release" badge. */
  releaseDate?: string | null;
  /** Community rating (0–10) when the catalog comes from TMDB. */
  voteAverage?: number | null;
  /** True when the movie opened recently — drives the "New" badge. */
  isNew?: boolean;
  /** Percent off every ticket for this movie — drives the "Promo" badge. */
  discountPercent?: number;
  /** Per-locale overrides (title/synopsis) coming from the catalog provider. */
  localized?: Partial<Record<Locale, LocalizedText>>;
  source?: "tmdb" | "local";
}

/** Title/synopsis resolved for the active language. */
export interface ResolvedMovieText {
  title: string;
  synopsis: string;
}

export interface Theater {
  id: string;
  name: string;
  city: string;
  /** Stable city id for geo selection (`nyc` / `msk` in the bundled catalog). */
  cityId: string;
  address: string;
  /** Map pin; absent when the cinema has no known position. */
  coordinates?: { lat: number; lng: number };
  /** Language this cinema belongs to (Moscow theatres for RU, NYC for EN). */
  locale: Locale;
  /** Translated name/address for the other language, when available. */
  localized?: Partial<Record<Locale, { name: string; city: string; address: string }>>;
}

/** Served city: stable id, localized names, map center, local currency. */
export interface City {
  id: string;
  countryCode: string;
  currency: Currency;
  center: { lat: number; lng: number };
  names: Record<Locale, string>;
}

/**
 * Detected region (GET /api/geo): client IP → geo lookup → served city.
 * Total contract — the server always fills every field (city fallback),
 * so the client can rely on `cityId` even when `detected` is false.
 */
export interface RegionInfo {
  /** True when a provider returned a real lookup for a public IP. */
  detected: boolean;
  /** "mock" | "ipapi" | "sypex" | "maxmind" — which source produced this region. */
  provider: string;
  /** Client IP the lookup ran for ("" when unknown). */
  ip: string;
  /** Served city matched from the lookup (or the default city). */
  cityId: string;
  countryCode: string;
  /** Raw ISO code from the provider (or the city's currency as fallback). */
  currency: string;
  latitude: number;
  longitude: number;
}

export interface Showtime {
  id: string;
  movieId: string;
  theaterId: string;
  theaterName: string;
  hall: string;
  /** ISO-8601 UTC instant, e.g. "2026-09-02T05:30:00.000Z" */
  startsAt: string;
  endsAt: string;
  /** Cinema-local calendar day, e.g. "2026-09-02" */
  date: string;
  /** Cinema-local time in 24h "HH:mm" form, e.g. "13:30" */
  time: string;
  /** IANA timezone of the cinema — "13:30" is 13:30 on that city's clock. */
  timeZone?: string;
  currency: Currency;
  fromPriceCents: number;
}

export interface ScreeningDay {
  /** Local calendar day, e.g. "2026-09-02" */
  date: string;
  label: string;
  times: ScreeningTime[];
}

export interface ScreeningTime {
  showtimeId: string;
  time: string;
  hall: string;
  fromPriceCents: number;
  seatsLeft: number;
}

export interface TheaterScreenings {
  theater: Theater;
  days: ScreeningDay[];
}

export interface HallLayout {
  rows: string[];
  columns: number;
  /** Column indexes after which an aisle is rendered. */
  aislesAfter: number[];
  classesByRow: Record<string, SeatClass>;
}

export interface Seat {
  id: string;
  row: string;
  number: number;
  /** Human readable seat label, e.g. "C7". */
  label: string;
  seatClass: SeatClass;
  status: SeatStatus;
  priceCents: number;
}

export interface SeatMap {
  showtimeId: string;
  hall: string;
  layout: HallLayout;
  seats: Seat[];
  capacity: number;
  seatsLeft: number;
}

export interface QuoteLine {
  seatId: string;
  label: string;
  seatClass: SeatClass;
  priceCents: number;
}

export interface Quote {
  currency: Currency;
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  discountPercent: number;
  promoCode: string | null;
  /** Loyalty points redeemed against this order (base-currency cents). */
  bonusCents?: number;
  serviceFeeCents: number;
  totalCents: number;
}

export interface Promotion {
  code: string;
  percent: number;
  description: string;
}

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "expired" | "failed";

export interface BookingSeat {
  seatId: string;
  label: string;
  seatClass: SeatClass;
  priceCents: number;
}

export interface Booking {
  id: string;
  code: string;
  /** Phone number the SMS code is sent to, masked (never the full number). */
  phone?: string | null;
  userId: string;
  showtimeId: string;
  status: BookingStatus;
  currency: Currency;
  movie: Pick<
    Movie,
    "id" | "slug" | "title" | "posterUrl" | "durationMinutes" | "localized" | "discountPercent"
  >;
  theaterName: string;
  theaterAddress: string;
  hall: string;
  startsAt: string;
  endsAt: string;
  /** IANA timezone of the cinema, so the show time renders in its own city. */
  timeZone?: string;
  seats: BookingSeat[];
  quote: Quote;
  /** How the booking was paid — mirrored from the settled payment intent. */
  payment?: {
    method: PaymentMethod;
    brand: CardBrand | null;
    last4: string | null;
    phoneMasked: string | null;
    provider?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export type PaymentMethod = "card" | "paypal";

export type CardBrand = "visa" | "mastercard" | "mir" | "amex" | "unionpay" | "unknown";

export type PaymentStatus = "requires_code" | "requires_action" | "succeeded" | "failed" | "refunded";

export interface PaymentIntent {
  id: string;
  bookingId: string;
  status: PaymentStatus;
  /** PSP settling the charge: mock | yookassa | stripe | paypal. */
  provider: string;
  method: PaymentMethod;
  amountCents: number;
  currency: Currency;
  cardBrand: CardBrand | null;
  cardLast4: string | null;
  /** Masked phone number the SMS code was sent to, e.g. "+7 *** ***-12-34". */
  phoneMasked: string | null;
  codeLength: number;
  expiresAt: string;
  attemptsLeft: number;
  /**
   * Off-site next step when status is `requires_action`
   * (3-D Secure redirect, PayPal approval). Null otherwise.
   */
  actionUrl?: string | null;
  /** Only populated outside production, so the demo flow can be exercised. */
  devCode?: string;
}

/** Audit trail entry (the subset visible in the GDPR export). */
export interface AuditEvent {
  id: string;
  /** ISO-8601 instant. */
  at: string;
  action: string;
  entityId: string | null;
  meta: Record<string, unknown> | null;
}

/** Public key used by the browser to encrypt card details (RSA-OAEP). */
export interface PaymentPublicKey {
  keyId: string;
  /** SPKI DER, base64 encoded. */
  publicKey: string;
  algorithm: "RSA-OAEP-256";
}

/** Runtime configuration the client needs before rendering money or forms. */
export interface AppConfig {
  locales: Locale[];
  defaultLocale: Locale;
  baseCurrency: Currency;
  currencies: Record<Locale, Currency>;
  fxRates: Record<Currency, number>;
  serviceFeeRate: number;
  smsCodeLength: number;
  maxSeatsPerBooking: number;
  paymentMethods: Array<{
    id: PaymentMethod;
    brands: CardBrand[];
  }>;
  catalogSource: "tmdb" | "local";
  /** True only outside production: the SMS code is echoed back for the demo. */
  exposesPaymentCode: boolean;
  /**
   * Which card form the checkout mounts (ТЗ §5–6). `embedded` is our own
   * RSA-encrypted form; `yookassa` / `stripe` mount the PSP's PCI-compliant
   * widget (Checkout.js / PaymentElement) — no PAN touches our DOM.
   */
  cardWidget: {
    provider: CardWidgetProvider;
    /** Publishable/public widget key; null when the provider is `embedded`. */
    publicKey: string | null;
  };
  /** Analytics ids (ТЗ §10). Empty strings mean "not configured". */
  analytics: {
    gtmId: string;
    ga4Id: string;
    ymId: string;
  };
  /** Public URL of the SPA — used for canonical/hreflang links. */
  siteUrl: string;
}

export type CardWidgetProvider = "embedded" | "yookassa" | "stripe";

/** Bonus points / referral wallet shown on the account page (ТЗ §2). */
export interface LoyaltySummary {
  /** Base-currency cents: 1¢ of bonus = 1¢ off. */
  balanceCents: number;
  earnedCents: number;
  spentCents: number;
  transactions: Array<{
    id: string;
    delta: number;
    reason: string;
    bookingId: string | null;
    createdAt: string;
  }>;
  referral: { code: string; invited: number };
}

/** Per-seat ticket (QR) issued when a booking is confirmed. */
export interface Ticket {
  id: string;
  bookingId: string;
  /** `CT-{bookingCode}-NN` — what the QR encodes. */
  qrCode: string;
  seatLabel: string;
  seatClass: SeatClass;
  status: "valid" | "refunded";
  issuedAt: string;
}

/** Public review of a movie (author name is a snapshot, never an email). */
export interface Review {
  id: string;
  movieId: string;
  authorName: string;
  /** 1–10, the same scale as TMDB ratings. */
  rating: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate + latest reviews, embedded in the movie detail payload. */
export interface ReviewSummary {
  count: number;
  /** Mean rating (0–10), null when nobody reviewed the movie yet. */
  average: number | null;
  items: Review[];
  locale: Locale;
}

export interface User {
  id: string;
  name: string;
  email: string;
  /** Verified phone number, when the user went through SMS verification. */
  phone?: string | null;
  /** ISO timestamp of the successful phone verification. */
  phoneVerifiedAt?: string | null;
  createdAt: string;
}

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

export type ApiErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "seat_unavailable"
  | "hold_expired"
  | "payment_failed"
  | "rate_limited"
  | "internal_error";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
