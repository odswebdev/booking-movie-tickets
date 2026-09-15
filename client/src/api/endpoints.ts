import type {
  AppConfig,
  AuditEvent,
  AuthSession,
  Booking,
  LoyaltySummary,
  Review,
  ReviewSummary,
  Ticket,
  BookingStatus,
  CardBrand,
  City,
  Currency,
  Locale,
  Movie,
  PaymentIntent,
  PaymentMethod,
  PaymentPublicKey,
  PaymentStatus,
  Promotion,
  RegionInfo,
  SeatMap,
  Showtime,
  Theater,
  TheaterScreenings,
  User,
} from "@shared/types";
import { api, tokenStore } from "./http";

export interface MovieListItem extends Movie {
  theatersCount: number;
  showtimesCount: number;
  nextShowtimeAt: string | null;
}

export interface MovieScreeningsResponse {
  movie: Movie;
  theaters: Theater[];
  screenings: TheaterScreenings[];
  dates: string[];
}

export interface HoldResponse {
  holdToken: string;
  expiresAt: string;
  seats: string[];
}

function persistSession(session: AuthSession): AuthSession {
  tokenStore.setAccess(session.accessToken);
  tokenStore.setRefresh(session.refreshToken);
  return session;
}

export type BookingScope = "upcoming" | "history" | "all";

/** GDPR data-portability export (mirrors the server's AccountExport). */
export interface AccountExport {
  user: User;
  bookings: Booking[];
  payments: Array<{
    id: string;
    bookingId: string;
    method: PaymentMethod;
    status: PaymentStatus;
    amountCents: number;
    currency: Currency;
    cardBrand: CardBrand | null;
    cardLast4: string | null;
    phoneMasked: string;
    createdAt: string;
  }>;
  audit: AuditEvent[];
  exportedAt: string;
}

export interface GuestCheckoutInput {
  name: string;
  email: string;
  phone?: string;
  showtimeId: string;
  seatIds: string[];
  holdToken?: string;
  promoCode?: string;
  bonusCents?: number;
}

export interface GuestCheckoutResult {
  booking: Booking;
  guest: { token: string; expiresAt: number };
  user: User;
}

export const authApi = {
  async register(input: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    /** Optional invite code — both sides get bonus points (ТЗ §2). */
    referralCode?: string;
  }): Promise<AuthSession> {
    return persistSession(await api.post<AuthSession>("/auth/register", input, { auth: false }));
  },

  async login(input: { email: string; password: string }): Promise<AuthSession> {
    return persistSession(await api.post<AuthSession>("/auth/login", input, { auth: false }));
  },

  async logout(): Promise<void> {
    const refreshToken = tokenStore.getRefresh();
    try {
      await api.post<void>("/auth/logout", { refreshToken }, { auth: false });
    } catch {
      // Logging out must always succeed locally, even if the API call fails.
    } finally {
      tokenStore.clear();
    }
  },

  /**
   * Гостевой checkout (ТЗ §5): книга мест для аккаунта-«лайт» без пароля.
   * Ответ несёт гостевой токен — дальнейшие шаги (оплата, билет) идут с ним.
   */
  guestCheckout(input: GuestCheckoutInput): Promise<GuestCheckoutResult> {
    return api.post<GuestCheckoutResult>("/auth/guest", input, { auth: false });
  },

  /** Превращает гостя в полноценный аккаунт, сохраняя его билеты. */
  async claimGuest(input: { guestToken: string; password: string }): Promise<AuthSession> {
    return persistSession(await api.post<AuthSession>("/auth/guest/claim", input, { auth: false }));
  },

  /** Passwordless sign-in (ТЗ §6): запрос ссылки и её одноразовый обмен. */
  magicLinkRequest(email: string): Promise<{ requested: boolean; devToken?: string }> {
    return api.post<{ requested: boolean; devToken?: string }>(
      "/auth/magic-link",
      { email },
      { auth: false },
    );
  },
  async magicLinkVerify(token: string): Promise<AuthSession> {
    return persistSession(await api.post<AuthSession>("/auth/magic-link/verify", { token }, { auth: false }));
  },

  /** SMS-верификация номера (purpose `phone_verify`). */
  phoneVerifyRequest(phone: string): Promise<{ delivered: boolean; phoneMasked: string; devCode?: string }> {
    return api.post<{ delivered: boolean; phoneMasked: string; devCode?: string }>("/auth/phone/verify", {
      phone,
    });
  },
  phoneVerifyConfirm(input: { code: string; phone?: string }): Promise<{ user: User }> {
    return api.post<{ user: User }>("/auth/phone/confirm", input);
  },

  /** Bonus wallet + referral code (ТЗ §2). */
  loyalty(): Promise<LoyaltySummary> {
    return api.get<LoyaltySummary>("/auth/loyalty");
  },

  me(): Promise<{ user: User }> {
    return api.get<{ user: User }>("/auth/me");
  },
  /** GDPR export (user, bookings, masked payments, audit trail). */
  exportData(): Promise<AccountExport> {
    return api.get<AccountExport>("/auth/export");
  },
  /** GDPR erasure (clears local tokens too — the account is gone). */
  async deleteAccount(): Promise<void> {
    await api.del<void>("/auth/account");
    tokenStore.clear();
  },
};

export const configApi = {
  get(signal?: AbortSignal): Promise<AppConfig> {
    return api.get<AppConfig>("/config", { auth: false, signal });
  },
  paymentKey(): Promise<PaymentPublicKey> {
    return api.get<PaymentPublicKey>("/config/payment-key", { auth: false });
  },
};

export const moviesApi = {
  list(locale?: Locale): Promise<{ items: MovieListItem[]; source: "tmdb" | "local" }> {
    const query = locale ? `?locale=${locale}` : "";
    return api.get<{ items: MovieListItem[]; source: "tmdb" | "local" }>(`/movies${query}`, {
      auth: false,
    });
  },
  bySlug(slug: string, locale?: Locale): Promise<MovieScreeningsResponse> {
    const query = locale ? `?locale=${locale}` : "";
    return api.get<MovieScreeningsResponse>(`/movies/${encodeURIComponent(slug)}${query}`, {
      auth: false,
    });
  },
  /** Public reviews of one movie (newest first). */
  reviews(slug: string, locale?: Locale): Promise<{ summary: ReviewSummary }> {
    const query = locale ? `?locale=${locale}` : "";
    return api.get<{ summary: ReviewSummary }>(`/movies/${encodeURIComponent(slug)}/reviews${query}`, {
      auth: false,
    });
  },
  myReview(slug: string): Promise<{ review: Review | null }> {
    return api.get<{ review: Review | null }>(`/movies/${encodeURIComponent(slug)}/reviews/mine`);
  },
  /** One review per viewer (upsert); requires a confirmed booking for the movie. */
  submitReview(
    slug: string,
    input: { rating: number; text: string },
  ): Promise<{ review: Review; summary: ReviewSummary }> {
    return api.post<{ review: Review; summary: ReviewSummary }>(
      `/movies/${encodeURIComponent(slug)}/reviews`,
      input,
    );
  },
};

export const geoApi = {
  /** Detected region: client IP → geo lookup → served city + currency. */
  region(signal?: AbortSignal): Promise<{ region: RegionInfo }> {
    return api.get<{ region: RegionInfo }>("/geo", { auth: false, signal });
  },
  cities(signal?: AbortSignal): Promise<{ items: City[] }> {
    return api.get<{ items: City[] }>("/cities", { auth: false, signal });
  },
  theaters(input: { city?: string; locale?: Locale }, signal?: AbortSignal): Promise<{ items: Theater[] }> {
    const params = new URLSearchParams();
    if (input.city) params.set("city", input.city);
    if (input.locale) params.set("locale", input.locale);
    const query = [...params].length > 0 ? `?${params}` : "";
    return api.get<{ items: Theater[] }>(`/theaters${query}`, { auth: false, signal });
  },
};

export interface ShowtimeAvailability {
  showtime: Showtime;
  /** Movie snapshot — used to preview the exact discount before booking. */
  movie: Pick<Movie, "id" | "slug" | "title" | "discountPercent" | "localized"> | null;
  capacity: number;
  seatsLeft: number;
}

export const showtimesApi = {
  get(showtimeId: string, signal?: AbortSignal): Promise<ShowtimeAvailability> {
    return api.get<ShowtimeAvailability>(`/showtimes/${showtimeId}`, { signal, auth: false });
  },
  seats(showtimeId: string, holdToken?: string | null, signal?: AbortSignal): Promise<SeatMap> {
    return api.get<SeatMap>(`/showtimes/${showtimeId}/seats`, {
      headers: holdToken ? { "X-Hold-Token": holdToken } : {},
      signal,
      auth: false,
    });
  },
  hold(showtimeId: string, seatIds: string[], holdToken?: string | null): Promise<HoldResponse> {
    return api.post<HoldResponse>(
      `/showtimes/${showtimeId}/holds`,
      { seatIds },
      { headers: holdToken ? { "X-Hold-Token": holdToken } : {}, auth: false },
    );
  },
  release(showtimeId: string, holdToken?: string | null): Promise<void> {
    return api.del<void>(`/showtimes/${showtimeId}/holds`, {
      headers: holdToken ? { "X-Hold-Token": holdToken } : {},
      auth: false,
    });
  },
};

export const bookingsApi = {
  list(scope: BookingScope = "all", signal?: AbortSignal): Promise<{ items: Booking[] }> {
    return api.get<{ items: Booking[] }>(`/bookings?scope=${scope}`, { signal });
  },
  create(input: {
    showtimeId: string;
    seatIds: string[];
    holdToken?: string;
    promoCode?: string;
  }): Promise<{ booking: Booking }> {
    return api.post<{ booking: Booking }>("/bookings", input);
  },
  get(bookingId: string): Promise<{ booking: Booking }> {
    return api.get<{ booking: Booking }>(`/bookings/${bookingId}`);
  },
  cancel(bookingId: string): Promise<{ booking: Booking }> {
    return api.post<{ booking: Booking }>(`/bookings/${bookingId}/cancel`);
  },
  /**
   * Cancels a confirmed booking and reverses the PSP charge. `refunded` is
   * false only when there was no charge to reverse (support reconciles).
   */
  refund(bookingId: string): Promise<{ booking: Booking; refunded: boolean }> {
    return api.post<{ booking: Booking; refunded: boolean }>(`/bookings/${bookingId}/refund`);
  },
  /** Applies a promo code to a pending booking (re-priced on the server). */
  applyPromo(bookingId: string, code: string): Promise<{ booking: Booking }> {
    return api.post<{ booking: Booking }>(`/bookings/${bookingId}/promo`, { code });
  },
  removePromo(bookingId: string): Promise<{ booking: Booking }> {
    return api.del<{ booking: Booking }>(`/bookings/${bookingId}/promo`);
  },
  /** Re-sends the PDF receipt to the account email (202: accepted for delivery). */
  receipt(bookingId: string): Promise<{ queued: boolean }> {
    return api.post<{ queued: boolean }>(`/bookings/${bookingId}/receipt`);
  },
  /** Per-seat ticket rows (QR `CT-{code}-NN`) issued at confirmation. */
  tickets(bookingId: string): Promise<{ items: Ticket[] }> {
    return api.get<{ items: Ticket[] }>(`/bookings/${bookingId}/tickets`);
  },
};

export interface CreateIntentInput {
  bookingId: string;
  method: "card" | "paypal";
  phone: string;
  /**
   * Card data in one of two shapes (ТЗ §5–6):
   * - RSA-OAEP encrypted payload — the plain number never leaves the browser;
   * - a PSP widget token (`Checkout.js` / Stripe Elements / Apple-Google Pay),
   *   with which no card data touches our site at all.
   */
  card?:
    | { keyId: string; encrypted: string }
    | {
        provider: "yookassa" | "stripe";
        token: string;
        wallet?: "apple_pay" | "google_pay";
        brand?: string;
        last4?: string;
      };
  paypal?: { email: string };
}

export const paymentsApi = {
  createIntent(input: CreateIntentInput): Promise<{ payment: PaymentIntent; smsDelivered: boolean }> {
    return api.post<{ payment: PaymentIntent; smsDelivered: boolean }>("/payments/intents", input);
  },
  verify(paymentId: string, code: string): Promise<{ payment: PaymentIntent; booking: Booking }> {
    return api.post<{ payment: PaymentIntent; booking: Booking }>(`/payments/${paymentId}/verify`, {
      code,
    });
  },
  resend(paymentId: string): Promise<{ payment: PaymentIntent }> {
    return api.post<{ payment: PaymentIntent }>(`/payments/${paymentId}/resend`);
  },
  get(paymentId: string): Promise<{ payment: PaymentIntent }> {
    return api.get<{ payment: PaymentIntent }>(`/payments/${paymentId}`);
  },
};

export const promotionsApi = {
  list(): Promise<{ items: Promotion[] }> {
    return api.get<{ items: Promotion[] }>("/promotions", { auth: false });
  },
  validate(
    code: string,
    seatCount?: number,
  ): Promise<{
    promotion: Promotion;
    appliedPercent: number;
    appliesNow: boolean;
    volumeDiscountPercent: number;
  }> {
    return api.post<{
      promotion: Promotion;
      appliedPercent: number;
      appliesNow: boolean;
      volumeDiscountPercent: number;
    }>("/promotions/validate", { code, seatCount }, { auth: false });
  },
};

export type { CardBrand, Promotion };

export type { Booking, BookingStatus, Movie, PaymentIntent, SeatMap, Showtime, TheaterScreenings, User };
