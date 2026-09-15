import type { Currency, Quote, QuoteLine, SeatClass } from "./types.js";

export type Locale = "en" | "ru";

/** Every amount in the system is stored in cents of this base currency. */
export const BASE_CURRENCY: Currency = "USD";

/** Display currency per UI language. */
export const CURRENCY_BY_LOCALE: Record<Locale, Currency> = {
  en: "USD",
  ru: "RUB",
};

/**
 * Conversion rates from the base currency. A production system would refresh
 * these from an FX provider; they are configurable through the API config so
 * the client always renders the same numbers as the server.
 */
export const FX_RATES: Record<Currency, number> = {
  USD: 1,
  RUB: 90,
};

export const LOCALE_INTL: Record<Locale, string> = {
  en: "en-US",
  ru: "ru-RU",
};

/** Convert base-currency cents into `currency` cents. */
export function convertCents(baseCents: number, currency: Currency = BASE_CURRENCY): number {
  return Math.round(baseCents * (FX_RATES[currency] ?? 1));
}

export function formatMoney(
  cents: number,
  currency: Currency = BASE_CURRENCY,
  locale: Locale = currency === "RUB" ? "ru" : "en",
): string {
  const amount = cents / 100;
  return new Intl.NumberFormat(LOCALE_INTL[locale], {
    style: "currency",
    currency,
    minimumFractionDigits: currency === "RUB" ? 0 : 2,
    maximumFractionDigits: currency === "RUB" ? 0 : 2,
  }).format(amount);
}

/** Formats an amount stored in base currency cents for the active language. */
export function formatMoneyForLocale(baseCents: number, locale: Locale): string {
  const currency = CURRENCY_BY_LOCALE[locale];
  return formatMoney(convertCents(baseCents, currency), currency, locale);
}

/** Service charge applied on top of the discounted ticket subtotal (6%). */
export const SERVICE_FEE_RATE = 0.06;

export const SEAT_CLASS_PRICES_CENTS: Record<SeatClass, number> = {
  standard: 1200,
  premium: 1800,
  recliner: 2500,
};

export const SEAT_CLASS_LABELS: Record<SeatClass, string> = {
  standard: "Standard",
  premium: "Premium",
  recliner: "Recliner",
};

/** Hard business limits, enforced on the server and used by the client for UX. */
export const MAX_SEATS_PER_BOOKING = 8;
export const SEAT_HOLD_TTL_SECONDS = 5 * 60;
/** The confirmation code is sent by SMS (4 digits, like most PSPs). */
/** OTP rules per ТЗ: 6 digits, 5-minute TTL, 3 attempts. */
export const SMS_CODE_LENGTH = 6;
export const SMS_CODE_TTL_SECONDS = 5 * 60;
export const SMS_MAX_ATTEMPTS = 3;
export const SMS_RESEND_COOLDOWN_SECONDS = 30;
export const CANCELLATION_CUTOFF_MINUTES = 120;

/**
 * Automatic volume discounts. Applied on top of the subtotal, before the
 * service charge; never stacked with a promo code (the better offer wins).
 */
export const BULK_DISCOUNT_TIERS: Array<{ minSeats: number; percent: number }> = [
  { minSeats: 6, percent: 15 },
  { minSeats: 4, percent: 10 },
];

export function bulkDiscountPercent(seatCount: number): number {
  const tier = BULK_DISCOUNT_TIERS.find((candidate) => seatCount >= candidate.minSeats);
  return tier?.percent ?? 0;
}

export function serviceFeeFor(subtotalCents: number): number {
  return Math.round(subtotalCents * SERVICE_FEE_RATE);
}

export interface QuoteInput {
  lines: QuoteLine[];
  /** Percent off the subtotal (promo code or volume discount). */
  discountPercent?: number;
  promoCode?: string | null;
  /** Loyalty points redeemed against this order, in base-currency cents. */
  bonusCents?: number;
}

/**
 * Single source of truth for money maths. The client uses it for a live
 * preview; the server re-computes it so a tampered request can never change
 * the price.
 */
export function computeQuote({
  lines,
  discountPercent = 0,
  promoCode = null,
  bonusCents = 0,
}: QuoteInput): Quote {
  const subtotalCents = lines.reduce((sum, line) => sum + line.priceCents, 0);
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  const discountedSubtotal = Math.max(0, subtotalCents - discountCents);
  const serviceFeeCents = serviceFeeFor(discountedSubtotal);
  const payableBeforeBonus = discountedSubtotal + serviceFeeCents;
  // Bonus points can never make the order free-er than the fee-only floor.
  const bonusApplied = Math.max(0, Math.min(Math.round(bonusCents), payableBeforeBonus));
  return {
    currency: BASE_CURRENCY,
    lines,
    subtotalCents,
    discountCents,
    discountPercent,
    promoCode,
    bonusCents: bonusApplied,
    serviceFeeCents,
    totalCents: payableBeforeBonus - bonusApplied,
  };
}
