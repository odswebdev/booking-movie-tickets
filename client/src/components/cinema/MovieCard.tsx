import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clock, Sparkles, Tag } from "lucide-react";
import type { Movie } from "@shared/types";
import { SEAT_CLASS_PRICES_CENTS } from "@shared/pricing";
import { formatDuration, movieText } from "@/lib/localize";
import { posterFor } from "@/lib/posters";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

export interface MovieCardProps {
  movie: Movie;
  /** Extra line, e.g. "3 cinemas · 12 showtimes today". */
  meta?: string;
  locale?: "en" | "ru";
  className?: string;
}

export function MovieCard({ movie, meta, locale, className }: MovieCardProps) {
  const { t } = useTranslation();
  const { locale: activeLocale, money } = useAppConfig();
  const language = locale ?? activeLocale;
  const { title } = movieText(movie, language);
  const poster = posterFor(movie.slug, movie.posterUrl);
  const discount = Math.max(0, movie.discountPercent ?? 0);

  return (
    <Link
      to={`/movies/${movie.slug}`}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-800/60 transition duration-200",
        "hover:-translate-y-1 hover:border-brand-500/40 hover:shadow-[0_28px_60px_-28px_rgba(29,231,130,0.6)]",
        "focus-visible:-translate-y-1 focus-visible:border-brand-500/60",
        className,
      )}
      aria-label={`${title} — ${t("movie.selectSeats")}`}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-ink-700">
        {poster ? (
          <img
            src={poster}
            alt={t("movie.posterAlt", { title })}
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition duration-500 group-hover:scale-[1.05]"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-ink-700 to-ink-800 text-sm text-white/60">
            <span className="px-4 text-center">{title}</span>
          </div>
        )}

        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
          <div className="flex flex-wrap gap-1.5">
            {movie.isNew ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-500 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-950 shadow">
                <Sparkles className="size-3" aria-hidden />
                {t("badges.new")}
              </span>
            ) : null}
            {discount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-950 shadow">
                <Tag className="size-3" aria-hidden />
                {t("badges.promo")} −{discount}%
              </span>
            ) : null}
          </div>
          <Badge tone="neutral" className="bg-black/70 backdrop-blur">
            {movie.rating}
          </Badge>
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2.5 pt-8">
          <p className="text-sm font-semibold text-white">
            {t("common.from")} {money(Math.round(SEAT_CLASS_PRICES_CENTS.standard * (1 - discount / 100)))}
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h3 className="line-clamp-2 text-base font-semibold leading-snug text-white">{title}</h3>
        <div className="flex items-center gap-3 text-xs text-white/55">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            {formatDuration(movie.durationMinutes, language)}
          </span>
          {movie.voteAverage ? (
            <span className="inline-flex items-center gap-1 text-brand-300">
              ★ {movie.voteAverage.toFixed(1)}
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 text-xs text-white/60">
          {movie.genres.join(" · ")}
          {meta ? ` — ${meta}` : ""}
        </p>
      </div>
    </Link>
  );
}
