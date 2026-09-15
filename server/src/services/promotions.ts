import { env } from "../config/env.js";
import { bulkDiscountPercent } from "../../../shared/pricing.js";
import type { Promotion } from "../../../shared/types.js";

/**
 * Promo codes are configured through `PROMO_CODES` ("CODE:percent,CODE:percent").
 * A volume discount (from 4 seats) is applied automatically; the customer gets
 * whichever offer is better — offers never stack, which keeps margins sane.
 */
const FALLBACK: Promotion[] = [
  { code: "WELCOME10", percent: 10, description: "10% off your first booking" },
  { code: "CINEMA20", percent: 20, description: "20% off selected screenings" },
  { code: "STUDENT15", percent: 15, description: "15% student discount" },
];

let promotions: Promotion[] = FALLBACK;

export function configurePromotions(raw: string = env.PROMO_CODES): void {
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, percent] = entry.split(":");
      const value = Number(percent);
      if (!code || !Number.isFinite(value) || value <= 0 || value > 90) return null;
      return {
        code: code.toUpperCase(),
        percent: Math.round(value),
        description: `${Math.round(value)}% off your booking`,
      } satisfies Promotion;
    })
    .filter((entry): entry is Promotion => entry !== null);

  promotions = parsed.length > 0 ? parsed : FALLBACK;
}

export function findPromotion(code: string): Promotion | null {
  const normalized = code.trim().toUpperCase();
  return promotions.find((promotion) => promotion.code === normalized) ?? null;
}

export function listPromotions(): Promotion[] {
  return [...promotions];
}

/** Best offer between a promo code and the automatic volume discount. */
export function resolveDiscount(
  promo: Promotion | null,
  seatCount: number,
): {
  percent: number;
  promoCode: string | null;
} {
  const volume = bulkDiscountPercent(seatCount);
  if (promo && promo.percent >= volume) {
    return { percent: promo.percent, promoCode: promo.code };
  }
  return { percent: volume, promoCode: null };
}
