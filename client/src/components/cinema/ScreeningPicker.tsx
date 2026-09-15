import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import type { TheaterScreenings } from "@shared/types";
import { formatDateKey, localizeHall } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { cn } from "@/lib/cn";

export interface ScreeningPickerProps {
  screenings: TheaterScreenings[];
  selectedShowtimeId: string | null;
  onSelect: (showtimeId: string) => void;
}

const PILL =
  "rounded-full border px-4 py-2 text-sm font-medium transition cursor-pointer " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500";
const PILL_IDLE = "border-white/20 text-white/80 hover:border-brand-500/60 hover:text-white";
const PILL_ACTIVE = "border-brand-500 bg-brand-500 text-ink-950";

/** Календарь сеансов — 14 дней (ТЗ §5): горизонт совпадает с окном брони. */
export const BOOKING_WINDOW_DAYS = 14;

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Continuous `windowDays`-day strip starting at the earliest known date. */
export function calendarWindow(dates: string[], windowDays = BOOKING_WINDOW_DAYS): string[] {
  const known = [...dates].sort();
  const start = known[0];
  if (!start) return [];
  return Array.from({ length: windowDays }, (_, index) => addDays(start, index));
}

/**
 * Cinema → date → time cascade.
 * The selected cinema/date is remembered per movie, and the time selection is
 * lifted to the parent so deep links and the booking draft stay in sync.
 */
export function ScreeningPicker({ screenings, selectedShowtimeId, onSelect }: ScreeningPickerProps) {
  const { t } = useTranslation();
  const { locale, money } = useAppConfig();
  const [theaterId, setTheaterId] = useState<string | null>(screenings[0]?.theater.id ?? null);
  const [date, setDate] = useState<string | null>(null);

  const activeTheater = useMemo(
    () => screenings.find((entry) => entry.theater.id === theaterId) ?? screenings[0],
    [screenings, theaterId],
  );

  // Keep the cascade consistent with whatever showtime is currently selected.
  useEffect(() => {
    if (!selectedShowtimeId) return;
    for (const entry of screenings) {
      for (const day of entry.days) {
        if (day.times.some((time) => time.showtimeId === selectedShowtimeId)) {
          setTheaterId(entry.theater.id);
          setDate(day.date);
          return;
        }
      }
    }
  }, [screenings, selectedShowtimeId]);

  const activeDate = useMemo(() => {
    const days = activeTheater?.days ?? [];
    return days.find((day) => day.date === date) ?? days[0] ?? null;
  }, [activeTheater, date]);

  // The strip spans the whole booking window, not just the days that happen
  // to have shows for this movie.
  const calendarDays = useMemo(() => {
    const known = [
      ...(activeTheater?.days ?? []).map((day) => day.date),
      ...screenings.flatMap((entry) => entry.days.map((day) => day.date)),
    ];
    return calendarWindow(known);
  }, [activeTheater, screenings]);

  if (!activeTheater) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-sm text-white/60">
        {t("movie.noShowtimes")}
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="cinema-heading">
        <h2 id="cinema-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
          {t("screening.cinema")}
        </h2>
        <div className="flex flex-wrap gap-2">
          {screenings.map((entry) => (
            <button
              key={entry.theater.id}
              type="button"
              onClick={() => {
                setTheaterId(entry.theater.id);
                setDate(null);
              }}
              aria-pressed={activeTheater.theater.id === entry.theater.id}
              className={cn(PILL, activeTheater.theater.id === entry.theater.id ? PILL_ACTIVE : PILL_IDLE)}
            >
              <span className="font-semibold">{entry.theater.name}</span>
              <span className="ml-1.5 text-xs opacity-70">{entry.theater.city}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-white/55">{activeTheater.theater.address}</p>
      </section>

      <section aria-labelledby="date-heading">
        <h2 id="date-heading" className="mb-1 text-sm font-semibold uppercase tracking-wide text-white/50">
          {t("screening.date")}
        </h2>
        <p className="mb-3 flex items-center gap-1.5 text-xs text-white/55">
          <CalendarDays className="size-3.5" aria-hidden />
          {t("movie.calendarWindow")}
        </p>
        {/* 14-дневная лента: дни без сеансов видны, но недоступны — покупатель
            сразу понимает, докуда дотягивается расписание. */}
        <div
          role="group"
          aria-label={t("screening.date")}
          className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
        >
          {calendarDays.map((dateKey) => {
            const day = activeTheater.days.find((entry) => entry.date === dateKey);
            const disabled = !day || day.times.length === 0;
            return (
              <button
                key={dateKey}
                type="button"
                disabled={disabled}
                onClick={() => setDate(dateKey)}
                aria-pressed={activeDate?.date === dateKey}
                aria-label={formatDateKey(dateKey, locale)}
                className={cn(
                  PILL,
                  "min-w-[74px] whitespace-nowrap text-center",
                  activeDate?.date === dateKey ? PILL_ACTIVE : PILL_IDLE,
                  disabled && "cursor-not-allowed opacity-35 hover:border-white/20 hover:text-white/80",
                )}
              >
                {formatDateKey(dateKey, locale)}
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="time-heading">
        <h2 id="time-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
          {t("screening.time")}
        </h2>
        {activeDate ? (
          <div className="flex flex-wrap gap-2">
            {activeDate.times.map((time) => {
              const isActive = time.showtimeId === selectedShowtimeId;
              const soldOut = time.seatsLeft === 0;
              return (
                <button
                  key={time.showtimeId}
                  type="button"
                  disabled={soldOut}
                  onClick={() => onSelect(time.showtimeId)}
                  aria-pressed={isActive}
                  className={cn(
                    PILL,
                    "flex flex-col items-start leading-tight",
                    isActive ? PILL_ACTIVE : PILL_IDLE,
                    soldOut && "cursor-not-allowed opacity-40 hover:border-white/20 hover:text-white/80",
                  )}
                >
                  <span className="text-base font-semibold">{time.time}</span>
                  <span className="text-[11px] opacity-70">
                    {localizeHall(time.hall, t)} · {t("common.from")} {money(time.fromPriceCents)}
                    {soldOut
                      ? ` · ${t("badges.soldOut")}`
                      : ` · ${t("badges.fewSeats", { count: time.seatsLeft })}`}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-white/50">{t("screening.selectDate")}</p>
        )}
      </section>
    </div>
  );
}
