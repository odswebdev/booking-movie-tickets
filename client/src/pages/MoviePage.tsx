import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Clock, PlayCircle, Sparkles, Star, Tag } from "lucide-react";
import { moviesApi } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useBookingFlow } from "@/context/BookingFlowContext";
import { formatDuration, movieText } from "@/lib/localize";
import { posterFor } from "@/lib/posters";
import { ScreeningPicker } from "@/components/cinema/ScreeningPicker";
import { TrailerModal } from "@/components/cinema/TrailerModal";
import { MovieReviews } from "@/components/cinema/MovieReviews";
import { useSeo } from "@/hooks/useSeo";
import { buildMovieJsonLd } from "@/lib/seoLd";
import { track } from "@/lib/analytics";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState, Skeleton } from "@/components/ui/Feedback";
import { useToast } from "@/context/ToastContext";
import { useAppConfig } from "@/i18n/AppConfigProvider";

export default function MoviePage() {
  const { t } = useTranslation();
  const { locale } = useAppConfig();
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { draft, setSelection, setSeats } = useBookingFlow();

  const [trailerOpen, setTrailerOpen] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.movie(slug, locale),
    queryFn: () => moviesApi.bySlug(slug, locale),
    enabled: slug.length > 0,
    staleTime: 30_000,
  });

  const movie = query.data?.movie;
  const text = movie ? movieText(movie, locale) : null;
  useDocumentTitle(text?.title ?? t("nav.home"));

  // SEO (ТЗ §8): title/description/OG/JSON-LD follow the SPA route.
  const screenings = query.data?.screenings ?? [];
  const theaterList = query.data?.theaters ?? [];
  useSeo({
    title: text ? `${text.title} — CineTickets` : t("nav.home"),
    description: text?.synopsis,
    locale,
    path: `/movies/${slug}`,
    image: movie?.posterUrl ?? null,
    type: "video.movie",
    jsonLd: movie
      ? buildMovieJsonLd({
          movie,
          locale,
          url: typeof window === "undefined" ? "" : window.location.href,
          screenings: screenings.flatMap((entry) =>
            entry.days.flatMap((day) =>
              day.times.map((time) => ({
                id: time.showtimeId,
                movieId: movie.id,
                theaterId: entry.theater.id,
                theaterName: entry.theater.name,
                hall: time.hall,
                startsAt: `${day.date}T${time.time}:00.000Z`,
                endsAt: `${day.date}T${time.time}:00.000Z`,
                date: day.date,
                time: time.time,
                currency: "USD" as const,
                fromPriceCents: time.fromPriceCents,
              })),
            ),
          ),
          theaters: theaterList,
        })
      : undefined,
  });

  // `view_movie` — the funnel's first step (ТЗ §10).
  useEffect(() => {
    if (!movie) return;
    track("view_movie", { movie_id: movie.id, movie_slug: movie.slug, title: movie.title, locale });
  }, [movie, locale]);

  const poster = movie ? posterFor(movie.slug, movie.posterUrl) : undefined;

  const selectedShowtimeId = useMemo(() => {
    if (!query.data || !draft.showtimeId) return null;
    const known = query.data.screenings.some((entry) =>
      entry.days.some((day) => day.times.some((time) => time.showtimeId === draft.showtimeId)),
    );
    return known ? draft.showtimeId : null;
  }, [query.data, draft.showtimeId]);

  const handleProceed = () => {
    if (!selectedShowtimeId) {
      toast({
        title: t("movie.chooseShowtime"),
        description: t("screening.selectDate"),
        variant: "warning",
      });
      return;
    }
    // Changing the showtime clears any seats picked earlier in this session.
    if (draft.showtimeId !== selectedShowtimeId) setSeats([]);
    setSelection(movie?.slug ?? slug, selectedShowtimeId);
    navigate(`/showtimes/${selectedShowtimeId}/seats`);
  };

  if (query.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[320px_1fr]">
        <Skeleton className="aspect-[2/3] w-full rounded-2xl" />
        <div className="space-y-4">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} title={t("movie.loadError")} />
      </div>
    );
  }

  if (!movie || !text) return null;
  const { screenings: movieScreenings } = query.data;
  const discount = Math.max(0, movie.discountPercent ?? 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate("/")}
        leftIcon={<ArrowLeft className="size-4" aria-hidden />}
        className="mb-6"
      >
        {t("movie.allMovies")}
      </Button>

      <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
        <div className="mx-auto w-full max-w-[320px] lg:mx-0">
          {poster ? (
            <img
              src={poster}
              alt={t("movie.posterAlt", { title: text.title })}
              className="w-full rounded-2xl shadow-2xl"
              width={320}
              height={480}
            />
          ) : (
            <div className="aspect-[2/3] w-full rounded-2xl bg-ink-700" />
          )}
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{movie.rating}</Badge>
            {movie.isNew ? (
              <Badge tone="brand">
                <Sparkles className="size-3" aria-hidden />
                {t("badges.new")}
              </Badge>
            ) : null}
            {discount > 0 ? (
              <Badge tone="warning">
                <Tag className="size-3" aria-hidden />
                {t("badges.promo")} −{discount}%
              </Badge>
            ) : null}
            {movie.genres.map((genre) => (
              <Badge key={genre}>{genre}</Badge>
            ))}
          </div>

          <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">{text.title}</h1>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-white/55">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-4" aria-hidden />
              {formatDuration(movie.durationMinutes, locale)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Star className="size-4" aria-hidden />
              {movie.voteAverage ? `★ ${movie.voteAverage.toFixed(1)}` : movie.releaseYear}
            </span>
          </div>

          <p className="mt-4 max-w-2xl leading-relaxed text-white/70">{text.synopsis}</p>

          <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
            <ScreeningPicker
              screenings={movieScreenings}
              selectedShowtimeId={selectedShowtimeId}
              onSelect={(showtimeId) => {
                if (draft.showtimeId !== showtimeId) setSeats([]);
                setSelection(movie.slug, showtimeId);
              }}
            />

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={handleProceed} disabled={!selectedShowtimeId}>
                {t("movie.selectSeats")}
              </Button>
              {movie.trailerUrl ? (
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={() => setTrailerOpen(true)}
                  leftIcon={<PlayCircle className="size-4" aria-hidden />}
                >
                  {t("movie.watchTrailer")}
                </Button>
              ) : null}
              {selectedShowtimeId ? null : (
                <p className="text-sm text-white/55">{t("movie.chooseShowtime")}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <MovieReviews slug={movie.slug} movieId={movie.id} />

      {movie.trailerUrl ? (
        <TrailerModal
          open={trailerOpen}
          onClose={() => setTrailerOpen(false)}
          trailerUrl={movie.trailerUrl}
          title={text.title}
          movieId={movie.id}
        />
      ) : null}
    </div>
  );
}
