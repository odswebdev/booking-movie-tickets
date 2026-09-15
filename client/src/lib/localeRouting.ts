import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "@/i18n";
import type { Locale } from "@shared/types";

/**
 * URL-префиксы локалей (ТЗ §9b): `/en/...`, `/ru/...`.
 *
 * The router is mounted with `basename = BASE_URL + locale`, so every internal
 * link in the app stays locale-less and React Router adds the prefix. These
 * helpers only handle the bootstrap (detect / normalise the prefix) and the
 * language switcher (move the current path to the other locale).
 */

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

export const LOCALE_PREFIXES = SUPPORTED_LOCALES;

export function isLocale(value: string | undefined): value is Locale {
  return value === "en" || value === "ru";
}

/** `base + "/en"` — the router basename for a locale. */
export function localeBase(locale: Locale): string {
  return `${BASE}/${locale}`;
}

/**
 * Extracts the locale prefix from a pathname.
 * Returns the locale and the path with the prefix removed.
 */
export function splitLocalePath(pathname: string): { locale: Locale | null; rest: string } {
  const withoutBase = BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const segments = withoutBase.split("/").filter(Boolean);
  const first = segments[0];
  if (isLocale(first)) {
    const rest = `/${segments.slice(1).join("/")}`;
    return { locale: first, rest: rest === "/" ? "/" : rest.replace(/\/$/, "") || "/" };
  }
  return { locale: null, rest: withoutBase.startsWith("/") ? withoutBase : `/${withoutBase}` };
}

/** Locale stored from a previous visit, else the browser preference. */
export function preferredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored ?? undefined)) return stored as Locale;
  } catch {
    /* storage blocked — fall through to the navigator */
  }
  if (typeof navigator !== "undefined") {
    for (const language of navigator.languages ?? [navigator.language]) {
      const short = language?.slice(0, 2).toLowerCase();
      if (isLocale(short)) return short;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Boots the locale from the URL: when the prefix is missing, the current URL
 * is rewritten in place (no reload, no history entry) so the address bar shows
 * the canonical `/en/... | /ru/...` shape before the first render.
 */
export function bootstrapLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const { locale, rest } = splitLocalePath(window.location.pathname);
  const resolved = locale ?? preferredLocale();
  if (!locale) {
    const search = window.location.search ?? "";
    const hash = window.location.hash ?? "";
    const normalized = rest === "/" ? "" : rest;
    window.history.replaceState(null, "", `${localeBase(resolved)}${normalized}${search}${hash}`);
  }
  return resolved;
}

/** Same page in another locale — used by the language switcher. */
export function switchLocaleUrl(locale: Locale, pathname: string, search = "", hash = ""): string {
  const { rest } = splitLocalePath(pathname);
  const normalized = rest === "/" ? "" : rest;
  return `${localeBase(locale)}${normalized}${search}${hash}`;
}
