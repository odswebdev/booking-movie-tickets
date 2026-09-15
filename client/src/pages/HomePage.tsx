import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, CalendarDays, MapPin, Tag } from "lucide-react";
import { moviesApi, promotionsApi, type MovieListItem } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { MovieCard } from "@/components/cinema/MovieCard";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/Feedback";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { movieText, formatDuration } from "@/lib/localize";
import { SEAT_CLASS_PRICES_CENTS } from "@shared/pricing";
import { posterFor } from "@/lib/posters";

export default function HomePage() {
  const { t } = useTranslation();
  const { locale, money } = useAppConfig();
  useDocumentTitle(t("nav.home"));

  const movies = useQuery({
    queryKey: queryKeys.movies(locale),
    queryFn: () => moviesApi.list(locale),
    staleTime: 60_000,
  });

  const promotions = useQuery({
    queryKey: queryKeys.promotions(),
    queryFn: () => promotionsApi.list(),
    staleTime: 5 * 60_000,
  });

  const data = movies.data;
  const [featured, ...rest] = data?.items ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <Hero />

      {movies.isPending ? (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="space-y-3">
              <Skeleton className="aspect-[2/3] w-full rounded-2xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : movies.isError ? (
        <ErrorState error={movies.error} onRetry={() => void movies.refetch()} title={t("home.loadError")} />
      ) : data && data.items.length === 0 ? (
        <EmptyState title={t("home.empty")} description={t("home.emptyDescription")} />
      ) : (
        <>
          {movies.isRefetching ? (
            <p className="mb-4 text-xs text-white/55" role="status">
              {t("home.refreshing")}
            </p>
          ) : null}

          {featured ? (
            <FeaturedMovie
              movie={featured}
              title={movieText(featured, locale).title}
              synopsis={movieText(featured, locale).synopsis}
              money={money}
            />
          ) : null}

          <section aria-labelledby="now-showing-heading" className="mt-12">
            <div className="mb-5 flex items-end justify-between gap-4">
              <h2 id="now-showing-heading" className="text-xl font-semibold text-white sm:text-2xl">
                {t("home.featured")}
              </h2>
              {promotions.data?.items.length ? (
                <p className="hidden items-center gap-1.5 text-xs text-white/55 sm:flex">
                  <Tag className="size-3.5" aria-hidden />
                  {t("home.promoHint", {
                    codes: promotions.data.items.map((item) => item.code).join(" · "),
                  })}
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
              {(featured ? rest : (data?.items ?? [])).map((movie) => (
                <MovieCard
                  key={movie.id}
                  movie={movie}
                  meta={
                    movie.nextShowtimeAt
                      ? `${movie.theatersCount} ${locale === "ru" ? "кинотеатров" : "cinemas"} · ${movie.showtimesCount} ${locale === "ru" ? "сеансов" : "shows"}`
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Hero() {
  const { t } = useTranslation();
  const { config } = useAppConfig();

  return (
    <section className="relative mb-12 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-ink-800 via-ink-850 to-ink-900 p-8 sm:p-12">
      <div
        className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-brand-500/20 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-32 left-1/3 size-72 rounded-full bg-warning/10 blur-3xl"
        aria-hidden
      />

      <div className="relative max-w-2xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-brand-400">
          {t("home.badge")}
        </p>
        <h1 className="text-3xl font-bold leading-tight text-white sm:text-5xl">{t("home.title")}</h1>
        <p className="mt-4 text-base text-white/65 sm:text-lg">{t("home.subtitle")}</p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a
            href="#now-showing-heading"
            className="inline-flex h-13 items-center gap-2.5 rounded-xl bg-brand-500 px-7 text-base font-semibold text-ink-950 shadow-[0_10px_30px_-12px_rgba(29,231,130,0.7)] transition hover:bg-brand-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            {t("home.cta")}
            <ArrowRight className="size-4" aria-hidden />
          </a>
          <span className="inline-flex items-center gap-2 text-xs text-white/55">
            <MapPin className="size-3.5" aria-hidden />
            {t("home.cities")}
          </span>
        </div>

        <p className="mt-6 text-[11px] uppercase tracking-wider text-white/50">
          {t("home.catalogSource", {
            source: config.catalogSource === "tmdb" ? "TMDB" : t("common.appName"),
          })}
        </p>
      </div>
    </section>
  );
}

function FeaturedMovie({
  movie,
  title,
  synopsis,
  money,
}: {
  movie: MovieListItem;
  title: string;
  synopsis: string;
  money: (cents: number) => string;
}) {
  const { t } = useTranslation();
  const { locale } = useAppConfig();
  const poster = posterFor(movie.slug, movie.posterUrl);
  const discount = Math.max(0, movie.discountPercent ?? 0);

  return (
    <section className="overflow-hidden rounded-3xl border border-white/10 bg-ink-800/50">
      <div className="flex flex-col gap-6 p-6 sm:flex-row sm:p-8">
        <div className="relative mx-auto w-44 shrink-0 overflow-hidden rounded-2xl bg-ink-700 shadow-2xl sm:mx-0 sm:w-56">
          {poster ? (
            <img
              src={poster}
              alt={t("movie.posterAlt", { title })}
              className="aspect-[2/3] w-full object-cover"
            />
          ) : null}
          {movie.isNew ? (
            <span className="absolute left-2 top-2 rounded-full bg-brand-500 px-2 py-0.5 text-[11px] font-bold uppercase text-ink-950">
              {t("badges.new")}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
            <span>{movie.rating}</span>
            <span aria-hidden>·</span>
            <span>{formatDuration(movie.durationMinutes, locale)}</span>
            <span aria-hidden>·</span>
            <span>{movie.genres.join(" · ")}</span>
          </div>

          <h2 className="mt-2 text-2xl font-bold text-white sm:text-3xl">{title}</h2>
          {discount > 0 ? (
            <p className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-warning/15 px-3 py-1 text-xs font-semibold text-amber-200">
              <Tag className="size-3.5" aria-hidden />
              {t("badges.promo")} −{discount}%
            </p>
          ) : null}

          <p className="mt-3 line-clamp-4 max-w-2xl text-sm text-white/60">{synopsis}</p>

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <ButtonLink
              to={`/movies/${movie.slug}`}
              rightIcon={<ArrowRight className="size-4" aria-hidden />}
            >
              {t("home.cta")}
            </ButtonLink>
            <span className="inline-flex items-center gap-1.5 text-sm text-white/50">
              <CalendarDays className="size-4" aria-hidden />
              {t("home.showsCount", { count: movie.showtimesCount })}
            </span>
            <span className="text-sm font-semibold text-brand-300">
              {t("common.from")} {money(Math.round(SEAT_CLASS_PRICES_CENTS.standard * (1 - discount / 100)))}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
