import { Router } from "express";
import { getCatalog } from "../services/catalog.js";
import { seatAvailability } from "../services/bookingService.js";
import { findUserReview, movieReviewSummary, submitReview } from "../services/loyaltyService.js";
import { reviewSchema } from "../../../shared/schemas.js";
import { ApiError } from "../utils/errors.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { catalogSourceName } from "../services/catalog.js";
import { routeParam } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { getRepositories } from "../db/provider.js";

export const moviesRouter: Router = Router();

const localeQuerySchema = z.object({ locale: z.enum(["en", "ru"]).optional() });

moviesRouter.get("/", validate(localeQuerySchema, "query"), (req, res) => {
  const { locale } = req.query as z.infer<typeof localeQuerySchema>;
  const catalog = getCatalog();
  const theaterIds = new Set(catalog.theatersForLocale(locale).map((theater) => theater.id));
  const movies = catalog.movies
    .map((movie) => {
      const showtimes = catalog
        .listShowtimes({ movieId: movie.id })
        .filter((showtime) => (locale ? theaterIds.has(showtime.theaterId) : true));
      return {
        ...movie,
        theatersCount: new Set(showtimes.map((showtime) => showtime.theaterId)).size,
        showtimesCount: showtimes.length,
        nextShowtimeAt: showtimes[0]?.startsAt ?? null,
      };
    })
    .filter((movie) => movie.showtimesCount > 0);

  res.json({ items: movies, source: catalogSourceName() });
});

moviesRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const locale = req.query.locale === "ru" ? "ru" : req.query.locale === "en" ? "en" : undefined;
    const catalog = getCatalog();
    const movie = catalog.movieBySlug(routeParam(req, "slug"));
    if (!movie) throw ApiError.notFound("Movie not found");

    const screenings = await Promise.all(
      catalog.screeningsForMovie(movie.id, locale).map(async (entry) => ({
        ...entry,
        days: await Promise.all(
          entry.days.map(async (day) => ({
            ...day,
            times: await Promise.all(
              day.times.map(async (time) => ({
                ...time,
                seatsLeft: (await seatAvailability(time.showtimeId)).seatsLeft,
              })),
            ),
          })),
        ),
      })),
    );

    const showtimes = catalog.listShowtimes({ movieId: movie.id });
    // Reviews live in the database; the aggregate feeds the JSON-LD
    // AggregateRating and the movie page stars.
    const reviews = await movieReviewSummary(movie.id, locale ?? "en");
    res.json({
      movie:
        reviews.count > 0
          ? { ...movie, voteAverage: reviews.average, reviewCount: reviews.count }
          : { ...movie, reviewCount: 0 },
      reviews,
      theaters: catalog.theaters,
      screenings,
      dates: [...new Set(showtimes.map((showtime) => showtime.date))].sort(),
    });
  }),
);

const reviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  locale: z.enum(["en", "ru"]).optional(),
});

/** Public reviews for one movie (newest first). */
moviesRouter.get(
  "/:slug/reviews",
  validate(reviewsQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { limit, locale } = req.query as unknown as z.infer<typeof reviewsQuerySchema>;
    const movie = getCatalog().movieBySlug(routeParam(req, "slug"));
    if (!movie) throw ApiError.notFound("Movie not found");
    const summary = await movieReviewSummary(movie.id, locale ?? "en", limit);
    res.json({ summary });
  }),
);

/** The signed-in visitor's own review, so the form can preload it. */
moviesRouter.get(
  "/:slug/reviews/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const movie = getCatalog().movieBySlug(routeParam(req, "slug"));
    if (!movie) throw ApiError.notFound("Movie not found");
    res.json({ review: await findUserReview(movie.id, req.auth!.userId) });
  }),
);

/**
 * One review per account per movie (upsert). Only visitors who actually have
 * a ticket for the movie may review it — keeps the rating honest.
 */
moviesRouter.post(
  "/:slug/reviews",
  requireAuth,
  validate(reviewSchema),
  asyncHandler(async (req, res) => {
    const { rating, text } = req.body as z.infer<typeof reviewSchema>;
    const movie = getCatalog().movieBySlug(routeParam(req, "slug"));
    if (!movie) throw ApiError.notFound("Movie not found");

    const userId = req.auth!.userId;
    const [user, bookings] = await Promise.all([
      getRepositories().users.findById(userId),
      getRepositories().bookings.listByUser(userId),
    ]);
    if (!user) throw ApiError.notFound("Account not found");
    const purchased = bookings.some(
      (booking) => booking.snapshot.movieId === movie.id && booking.status === "confirmed",
    );
    if (!purchased) {
      throw ApiError.forbidden("Only viewers with a ticket for this movie can review it");
    }

    const review = await submitReview({
      movieId: movie.id,
      userId,
      authorName: user.name,
      rating,
      text,
    });
    res.status(201).json({ review, summary: await movieReviewSummary(movie.id, "en") });
  }),
);
