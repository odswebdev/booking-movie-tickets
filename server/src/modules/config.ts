import { Router } from "express";
import {
  CURRENCY_BY_LOCALE,
  FX_RATES,
  SERVICE_FEE_RATE,
  SMS_CODE_LENGTH,
  MAX_SEATS_PER_BOOKING,
} from "../../../shared/pricing.js";
import type { AppConfig, CardWidgetProvider } from "../../../shared/types.js";
import { env } from "../config/env.js";
import { fxRates } from "../services/fx.js";
import { catalogSourceName } from "../services/catalog.js";
import { getPaymentKeyPair } from "../services/cryptoService.js";

/**
 * Resolves which checkout form to mount. `auto` prefers a configured widget
 * (YooKassa first, then Stripe) and falls back to the encrypted embedded form
 * — a deployment without widget keys keeps working exactly as before.
 */
export function resolveCardWidget(): { provider: CardWidgetProvider; publicKey: string | null } {
  const yookassaKey = env.YOOKASSA_PUBLIC_KEY ?? null;
  const stripeKey = env.STRIPE_PUBLISHABLE_KEY ?? null;
  switch (env.CARD_WIDGET) {
    case "yookassa":
      return { provider: "yookassa", publicKey: yookassaKey };
    case "stripe":
      return { provider: "stripe", publicKey: stripeKey };
    case "embedded":
      return { provider: "embedded", publicKey: null };
    default:
      if (yookassaKey) return { provider: "yookassa", publicKey: yookassaKey };
      if (stripeKey) return { provider: "stripe", publicKey: stripeKey };
      return { provider: "embedded", publicKey: null };
  }
}

export const configRouter: Router = Router();

/**
 * Runtime configuration for the client: locales, currencies, FX, payment
 * methods and the public key used to encrypt card details in the browser.
 */
configRouter.get("/", (_req, res) => {
  const config: AppConfig = {
    locales: ["en", "ru"],
    defaultLocale: "en",
    baseCurrency: "USD",
    currencies: CURRENCY_BY_LOCALE,
    fxRates: fxRates(),
    serviceFeeRate: SERVICE_FEE_RATE,
    smsCodeLength: SMS_CODE_LENGTH,
    maxSeatsPerBooking: MAX_SEATS_PER_BOOKING,
    paymentMethods: [
      { id: "card", brands: ["visa", "mastercard", "mir", "amex", "unionpay"] },
      { id: "paypal", brands: [] },
    ],
    catalogSource: catalogSourceName(),
    exposesPaymentCode: !env.isProduction,
    cardWidget: resolveCardWidget(),
    analytics: { gtmId: env.GTM_ID, ga4Id: env.GA4_ID, ymId: env.YM_ID },
    siteUrl: env.APP_PUBLIC_URL,
  };
  res.json(config);
});

/** RSA-OAEP public key (SPKI, base64) used by the checkout form. */
configRouter.get("/payment-key", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(getPaymentKeyPair().publicKey);
});

export { FX_RATES };
