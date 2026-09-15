import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarClock, MapPin, Ticket as TicketIcon, Users } from "lucide-react";
import type { Booking } from "@shared/types";
import { CANCELLATION_CUTOFF_MINUTES } from "@shared/pricing";
import { formatShowDateTime, localizeHall, movieText } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { posterFor } from "@/lib/posters";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const STATUS_TONE = {
  confirmed: "success",
  pending: "warning",
  cancelled: "danger",
  expired: "neutral",
  failed: "danger",
} as const;

export interface TicketCardProps {
  booking: Booking;
  onCancel?: ((booking: Booking) => void) | undefined;
  cancelling?: boolean;
}

export function TicketCard({ booking, onCancel, cancelling }: TicketCardProps) {
  const { t } = useTranslation();
  const { locale, money } = useAppConfig();
  const poster = posterFor(booking.movie.slug, booking.movie.posterUrl);
  const title = movieText(booking.movie, locale).title;
  const startsAt = new Date(booking.startsAt).getTime();
  const canCancel =
    booking.status === "confirmed" &&
    startsAt - Date.now() > CANCELLATION_CUTOFF_MINUTES * 60_000 &&
    Boolean(onCancel);

  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-ink-800/60 p-4 sm:flex-row">
      <div className="mx-auto w-24 shrink-0 sm:mx-0">
        {poster ? (
          <img
            src={poster}
            alt={t("movie.posterAlt", { title })}
            loading="lazy"
            className="w-full rounded-lg"
          />
        ) : (
          <div className="aspect-[2/3] w-full rounded-lg bg-ink-700" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-white">{title}</h3>
          <Badge tone={STATUS_TONE[booking.status]}>{t(`ticket.status.${booking.status}`)}</Badge>
        </div>

        <dl className="mt-3 grid gap-1.5 text-sm text-white/65 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 shrink-0 text-white/40" aria-hidden />
            <dd>{formatShowDateTime(booking.startsAt, locale, booking.timeZone)}</dd>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="size-4 shrink-0 text-white/40" aria-hidden />
            <dd className="truncate">
              {booking.theaterName} · {localizeHall(booking.hall, t)}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <Users className="size-4 shrink-0 text-white/40" aria-hidden />
            <dd>
              {t("common.seat", { count: booking.seats.length })} (
              {booking.seats.map((seat) => seat.label).join(", ")})
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <TicketIcon className="size-4 shrink-0 text-white/40" aria-hidden />
            <dd className="font-mono text-xs tracking-wider text-white/80">{booking.code}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-brand-400">{money(booking.quote.totalCents)}</span>
          <Link
            to={`/tickets/${booking.id}`}
            className="text-sm font-medium text-white/80 underline-offset-4 transition hover:text-white hover:underline"
          >
            {t("ticket.view")}
          </Link>
          {canCancel ? (
            <Button
              variant="ghost"
              size="sm"
              loading={cancelling}
              onClick={() => onCancel?.(booking)}
              className="text-danger hover:bg-danger/10 hover:text-danger"
            >
              {t("ticket.cancel")}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
