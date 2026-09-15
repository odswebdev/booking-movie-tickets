import type { Locale } from "./types.js";

/**
 * Single source of truth for cinema geography shared by API and web client.
 * Each language has its own city: English shows New York cinemas, Russian
 * shows Moscow ones — both catalogue and timezone follow the UI language.
 */
export const THEATER_TIMEZONE: Record<Locale, string> = {
  en: "America/New_York",
  ru: "Europe/Moscow",
};

/** Default (English) cinema timezone, used when no locale is known. */
export const CINEMA_TIMEZONE = THEATER_TIMEZONE.en;
export const CINEMA_LOCALE = "en-US";
