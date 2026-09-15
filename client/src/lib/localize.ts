import { THEATER_TIMEZONE } from "@shared/cinema";
import { LOCALE_INTL } from "@shared/pricing";
import type { Locale, Movie, ResolvedMovieText, SeatClass } from "@shared/types";

/** Any shape that carries a title plus optional per-locale overrides. */
export type LocalizableMovie = Pick<Movie, "title" | "localized"> & { synopsis?: string | null };

/** Picks the translated title/synopsis for the active language. */
export function movieText(movie: LocalizableMovie, locale: Locale): ResolvedMovieText {
  const localized = movie.localized?.[locale];
  return {
    title: localized?.title?.trim() || movie.title,
    synopsis: localized?.synopsis?.trim() || movie.synopsis || "",
  };
}

/** Translated seat-class name ("Standard" / "Стандарт"). */
export function seatClassLabel(seatClass: SeatClass, t: (key: string) => string): string {
  return t(`seats.class.${seatClass}`);
}

/** "Hall 2" → "Зал 2" for the Russian UI (cinema names stay as they are). */
export function localizeHall(hall: string, t: (key: string) => string): string {
  return hall.replace(/^Hall\s*/i, `${t("screening.hall")} `);
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = build();
  cache.set(key, value);
  return value;
}

/** "Sat, 14 Sep, 18:30" in the cinema's own timezone and the UI's language. */
export function formatShowDateTime(iso: string, locale: Locale, timeZone?: string): string {
  const zone = timeZone ?? THEATER_TIMEZONE[locale];
  const fmt = formatter(
    dateTimeFormatters,
    `${locale}|${zone}`,
    () =>
      new Intl.DateTimeFormat(LOCALE_INTL[locale], {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: zone,
      }),
  );
  return fmt.format(new Date(iso));
}

export function formatShowDate(iso: string, locale: Locale, timeZone?: string): string {
  const zone = timeZone ?? THEATER_TIMEZONE[locale];
  const fmt = formatter(
    dateFormatters,
    `${locale}|${zone}`,
    () =>
      new Intl.DateTimeFormat(LOCALE_INTL[locale], {
        weekday: "short",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: zone,
      }),
  );
  return fmt.format(new Date(iso));
}

export function formatShowTime(iso: string, locale: Locale, timeZone?: string): string {
  const zone = timeZone ?? THEATER_TIMEZONE[locale];
  const fmt = formatter(
    timeFormatters,
    `${locale}|${zone}`,
    () =>
      new Intl.DateTimeFormat(LOCALE_INTL[locale], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: zone,
      }),
  );
  return fmt.format(new Date(iso));
}

/** "Sat, 14 Sep" for a plain "YYYY-MM-DD" date key. */
export function formatDateKey(dateKey: string, locale: Locale): string {
  const fmt = formatter(
    dateFormatters,
    `key|${locale}`,
    () =>
      new Intl.DateTimeFormat(LOCALE_INTL[locale], {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
  );
  return fmt.format(new Date(`${dateKey}T12:00:00.000Z`));
}

/** "2h 28m" / "2 ч 28 мин". */
export function formatDuration(minutes: number, locale: Locale): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (locale === "ru") {
    if (hours === 0) return `${rest} мин`;
    if (rest === 0) return `${hours} ч`;
    return `${hours} ч ${rest} мин`;
  }
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

const relativeFormatters = new Map<Locale, Intl.RelativeTimeFormat>();

/** "in 3 days" / "через 3 дня". */
export function formatRelative(iso: string, locale: Locale, now: Date = new Date()): string {
  const fmt = formatter(
    relativeFormatters,
    locale,
    () => new Intl.RelativeTimeFormat(LOCALE_INTL[locale], { numeric: "auto" }),
  );
  const diffMinutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
  ];

  let value = diffMinutes;
  for (const [unit, limit] of units) {
    if (Math.abs(value) < limit) return fmt.format(value, unit);
    value = Math.round(value / limit);
  }
  return fmt.format(value, "year");
}

/** "04:59" countdown for the seat-hold timer. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
