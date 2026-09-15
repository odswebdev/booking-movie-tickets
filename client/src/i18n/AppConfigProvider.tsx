import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  CURRENCY_BY_LOCALE,
  FX_RATES,
  MAX_SEATS_PER_BOOKING,
  SERVICE_FEE_RATE,
  SMS_CODE_LENGTH,
  convertCents,
  formatMoney,
} from "@shared/pricing";
import type { AppConfig, CardBrand, Locale, PaymentMethod } from "@shared/types";
import { api } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";

/**
 * Runtime configuration served by the API (currencies, FX, payment methods,
 * limits). Defaults come from the shared module so the UI is correct even
 * before the request resolves or if the API is unreachable.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  locales: ["en", "ru"],
  defaultLocale: "en",
  baseCurrency: "USD",
  currencies: CURRENCY_BY_LOCALE,
  fxRates: FX_RATES,
  serviceFeeRate: SERVICE_FEE_RATE,
  smsCodeLength: SMS_CODE_LENGTH,
  maxSeatsPerBooking: MAX_SEATS_PER_BOOKING,
  paymentMethods: [
    { id: "card", brands: ["visa", "mastercard", "mir", "amex", "unionpay"] },
    { id: "paypal", brands: [] },
  ],
  catalogSource: "local",
  exposesPaymentCode: true,
  // Defaults mirror the server: embed our own RSA-encrypted form and load no
  // tag manager until /config answers.
  cardWidget: { provider: "embedded", publicKey: null },
  analytics: { gtmId: "", ga4Id: "", ymId: "" },
  siteUrl: "",
};

interface AppConfigValue {
  config: AppConfig;
  locale: Locale;
  /** Amounts are stored in base currency (USD) cents on the server. */
  currency: AppConfig["currencies"][Locale];
  /** Formats an amount held in base-currency cents for the active language. */
  money: (baseCents: number) => string;
  /** Converts base-currency cents into the display currency, without symbols. */
  convert: (baseCents: number) => number;
  cardBrands: CardBrand[];
  methods: PaymentMethod[];
  /** Checkout form the server told us to mount (ТЗ §5–6). */
  cardWidget: AppConfig["cardWidget"];
  analytics: AppConfig["analytics"];
  siteUrl: string;
}

const AppConfigContext = createContext<AppConfigValue | null>(null);

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();

  const { data } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: () => api.get<AppConfig>("/config", { auth: false }),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const config = data ?? DEFAULT_APP_CONFIG;
  const locale: Locale = i18n.language === "ru" ? "ru" : "en";
  const currency = config.currencies[locale];

  const value = useMemo<AppConfigValue>(() => {
    const rates = { ...FX_RATES, ...config.fxRates };
    const rate = rates[currency] ?? 1;
    return {
      config,
      locale,
      currency,
      money: (baseCents: number) => formatMoney(Math.round(baseCents * rate), currency, locale),
      convert: (baseCents: number) => convertCents(baseCents, currency),
      cardBrands: config.paymentMethods.find((method) => method.id === "card")?.brands ?? [],
      methods: config.paymentMethods.map((method) => method.id),
      cardWidget: config.cardWidget,
      analytics: config.analytics,
      siteUrl: config.siteUrl,
    };
  }, [config, currency, locale]);

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfigValue {
  const value = useContext(AppConfigContext);
  if (!value) throw new Error("useAppConfig must be used inside <AppConfigProvider>");
  return value;
}

/** Shorthand: `const { money } = useMoney();` */
export function useMoney() {
  const { money, convert, currency, locale } = useAppConfig();
  return { money, convert, currency, locale };
}
