import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import ru from "./locales/ru.json";

export const SUPPORTED_LOCALES = ["en", "ru"] as const;
export const DEFAULT_LOCALE = "en";
export const LOCALE_STORAGE_KEY = "cinetickets.locale";

export const LOCALE_LABELS: Record<
  (typeof SUPPORTED_LOCALES)[number],
  { label: string; native: string; flag: string }
> = {
  en: { label: "English", native: "English", flag: "EN" },
  ru: { label: "Russian", native: "Русский", flag: "RU" },
};

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });

export default i18n;
