import { Router } from "express";
import { paymentLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/errors.js";
import { routeParam } from "../utils/http.js";
import { logger } from "../utils/logger.js";
import { providerByName } from "../services/payments/factory.js";
import { ProviderChargeError } from "../services/payments/types.js";
import { applyProviderWebhook } from "../services/payments/webhooks.js";

export const webhooksRouter: Router = Router();

/**
 * Provider webhooks: POST /api/webhooks/:provider
 * (yookassa | stripe | paypal | mock).
 *
 * No session auth here — authenticity comes from the provider's own
 * mechanism (Stripe HMAC, PayPal verify API, YooKassa API round-trip).
 * Signature verification runs BEFORE any business logic; every verified
 * event is applied idempotently by (provider, eventId).
 */
webhooksRouter.post(
  "/:provider",
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const name = routeParam(req, "provider");
    const provider = providerByName(name);
    if (!provider) {
      throw ApiError.notFound(`Unknown or unconfigured payment provider: ${name}`);
    }

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    let outcome;
    try {
      const verified = await provider.verifyWebhook(rawBody, headers);
      outcome = await applyProviderWebhook(provider.name, verified);
    } catch (error) {
      if (error instanceof ProviderChargeError && error.kind === "invalid_webhook") {
        logger.warn({ provider: name, reason: error.message }, "webhook signature check failed");
        throw new ApiError(401, "unauthorized", "Invalid webhook signature");
      }
      throw error;
    }

    // Always 200 once verified — even for duplicates/unknown refs — so the
    // provider stops retrying an event that would never apply.
    res.json({ ok: true, ...outcome });
  }),
);
