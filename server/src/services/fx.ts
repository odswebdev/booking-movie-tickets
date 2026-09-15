import { FX_RATES } from "../../../shared/pricing.js";
import type { Currency } from "../../../shared/types.js";

/**
 * FX rates are baked in as defaults but can be overridden with env vars
 * (`FX_RATES=RUB:92.5,...`), so prices stay consistent between the API and the
 * web client without shipping a full currency service.
 */
let rates: Record<Currency, number> = { ...FX_RATES };

export function configureRates(overrides: Partial<Record<Currency, number>> = {}): void {
  rates = { ...FX_RATES, ...overrides };
}

export function fxRates(): Record<Currency, number> {
  return { ...rates };
}

export function convert(baseCents: number, currency: Currency): number {
  return Math.round(baseCents * (rates[currency] ?? 1));
}

/** Parses `RUB:92.5,USD:1` style configuration. */
export function parseRateOverrides(raw: string | undefined): Partial<Record<Currency, number>> {
  if (!raw) return {};
  const result: Partial<Record<Currency, number>> = {};
  for (const chunk of raw.split(",")) {
    const [key, value] = chunk.split(":").map((part) => part.trim());
    const numeric = Number(value);
    if ((key === "USD" || key === "RUB") && Number.isFinite(numeric) && numeric > 0) {
      result[key] = numeric;
    }
  }
  return result;
}
