/**
 * Cinema-local time helpers.
 *
 * Cinemas now live in two cities (New York for the English catalog, Moscow for
 * the Russian one), so every helper takes an explicit IANA timezone. A showtime
 * is stored as a UTC instant and rendered back in the cinema's own zone, which
 * keeps "18:30" meaning 18:30 on the wall clock of that city all year round
 * (Europe/Moscow has no DST, America/New_York does).
 */
import { CINEMA_TIMEZONE } from "../../../shared/cinema.js";

export { CINEMA_TIMEZONE };

function partsInZone(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  // Midnight can come back as hour 24 in some ICU versions.
  if (result.hour === 24) result.hour = 0;
  return result;
}

/** Offset (in minutes) between UTC and `timeZone` at the given instant. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

const cachedOffsets = new Map<string, number>();

/** Cached offset lookup — showtime generation calls this a lot. */
export function offsetFor(timeZone: string, instant: Date = new Date()): number {
  const key = `${timeZone}|${Math.floor(instant.getTime() / 3_600_000)}`;
  const hit = cachedOffsets.get(key);
  if (hit !== undefined) return hit;
  const value = zoneOffsetMinutes(instant, timeZone);
  cachedOffsets.set(key, value);
  return value;
}

/** Converts a cinema-local date + "HH:mm" pair into a UTC instant. */
export function localToUtc(dateKey: string, time: string, timeZone: string = CINEMA_TIMEZONE): Date {
  const [year = 1970, month = 1, day = 1] = dateKey.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);

  // Two passes so DST transitions resolve to the correct instant.
  const firstGuess = new Date(wallClock - offsetFor(timeZone, new Date(wallClock)) * 60_000);
  const offset = offsetFor(timeZone, firstGuess);
  return new Date(wallClock - offset * 60_000);
}

/** "YYYY-MM-DD" for the cinema-local calendar day of `instant`. */
export function toDateKey(
  instant: Date | string | number = new Date(),
  timeZone: string = CINEMA_TIMEZONE,
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date);
}

/** "HH:mm" (24h) for the cinema-local wall clock time of `instant`. */
export function toLocalTime(instant: Date | string | number, timeZone: string = CINEMA_TIMEZONE): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}

export function isTodayKey(dateKey: string, timeZone: string = CINEMA_TIMEZONE): boolean {
  return dateKey === toDateKey(new Date(), timeZone);
}

/** Date keys are pure calendar arithmetic, so UTC maths stays exact. */
export function addDays(dateKey: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Human label for a date key, e.g. "Wed, 2 Sep". */
export function formatDateKeyLabel(
  dateKey: string,
  timeZone: string = CINEMA_TIMEZONE,
  locale = "en-GB",
): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  const formatted = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(date);
  return formatted;
}

/** Consecutive date keys starting today — the bookable window. */
export function bookingWindow(
  days: number,
  from: Date = new Date(),
  timeZone: string = CINEMA_TIMEZONE,
): string[] {
  const start = toDateKey(from, timeZone);
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  const start = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const end = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return Math.round((end - start) / 60000);
}

const TTL_UNITS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/**
 * "30s" | "15m" | "1h" | "7d" | "900" → seconds.
 * The format is validated in `config/env.ts`, so this never throws at runtime;
 * an unparseable value falls back to 15 minutes instead of producing NaN
 * tokens (a NaN expiry used to make every login fail with a 500).
 */
export function parseTtlSeconds(value: string, fallback = 900): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(value.trim());
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const seconds = amount * (TTL_UNITS[unit] ?? 1);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : fallback;
}
