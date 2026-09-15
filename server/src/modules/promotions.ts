import { Router } from "express";
import { promoCodeSchema } from "../../../shared/schemas.js";
import { bulkDiscountPercent, computeQuote, serviceFeeFor } from "../../../shared/pricing.js";
import { findPromotion, listPromotions, resolveDiscount } from "../services/promotions.js";
import { validate } from "../middleware/validate.js";
import { ApiError } from "../utils/errors.js";

export const promotionsRouter: Router = Router();

/** Public list of active offers (shown on the home page as hints). */
promotionsRouter.get("/", (_req, res) => {
  res.json({ items: listPromotions() });
});

/** Validates a code and previews the discount before the order is created. */
promotionsRouter.post("/validate", validate(promoCodeSchema), (req, res) => {
  const { code, seatCount } = req.body as { code: string; seatCount?: number };
  const promotion = findPromotion(code);
  if (!promotion) {
    throw ApiError.validation("That promo code is not valid", [
      { field: "code", message: "Invalid or expired promo code" },
    ]);
  }

  const { percent, promoCode } = resolveDiscount(promotion, seatCount ?? 1);
  res.json({
    promotion,
    appliedPercent: percent,
    appliesNow: promoCode === promotion.code,
    volumeDiscountPercent: bulkDiscountPercent(seatCount ?? 1),
  });
});

/** Price preview used by the client before a booking exists. */
promotionsRouter.post("/preview", (req, res) => {
  const body = req.body as { lines?: Array<{ priceCents: number }>; discountPercent?: number };
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (lines.length === 0) throw ApiError.badRequest("Provide at least one seat line");

  const quote = computeQuote({
    lines: lines.map((line, index) => ({
      seatId: `preview-${index}`,
      label: `Seat ${index + 1}`,
      seatClass: "standard",
      priceCents: Math.max(0, Math.round(line.priceCents ?? 0)),
    })),
    discountPercent: Math.max(0, Math.min(90, Math.round(body?.discountPercent ?? 0))),
  });
  res.json({ quote, serviceFeeRate: serviceFeeFor(100) / 100 });
});
