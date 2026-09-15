import { Router } from "express";
import { z } from "zod";
import { seatSelectionSchema } from "../../../shared/schemas.js";
import { getCatalog } from "../services/catalog.js";
import { getSeatMap, holdSeats, releaseHolds, seatAvailability } from "../services/bookingService.js";
import { viewerFrom } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/errors.js";
import { routeParam } from "../utils/http.js";
import { getSeatBus } from "../db/provider.js";

export const showtimesRouter: Router = Router();

const listQuerySchema = z.object({
  movieId: z.string().optional(),
  theaterId: z.string().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

showtimesRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { movieId, theaterId, date } = req.query as z.infer<typeof listQuerySchema>;
    const showtimes = await Promise.all(
      getCatalog()
        .listShowtimes({ movieId, theaterId, date })
        .map(async (showtime) => ({ ...showtime, ...(await seatAvailability(showtime.id)) })),
    );
    res.json({ items: showtimes });
  }),
);

showtimesRouter.get(
  "/:showtimeId",
  asyncHandler(async (req, res) => {
    const catalog = getCatalog();
    const showtime = catalog.showtimeById(routeParam(req, "showtimeId"));
    if (!showtime) throw ApiError.notFound("Showtime not found");
    const movie = catalog.movieById(showtime.movieId);

    res.json({
      showtime,
      // Lets the seat page preview exactly the price the server will charge.
      movie: movie
        ? {
            id: movie.id,
            slug: movie.slug,
            title: movie.title,
            discountPercent: movie.discountPercent ?? 0,
            localized: movie.localized,
          }
        : null,
      ...(await seatAvailability(showtime.id)),
    });
  }),
);

showtimesRouter.get(
  "/:showtimeId/seats",
  asyncHandler(async (req, res) => {
    res.json(await getSeatMap(routeParam(req, "showtimeId"), viewerFrom(req)));
  }),
);

/**
 * Server-Sent Events stream of seat-map changes for one showtime.
 *
 * Event names: `ready` (one-shot handshake), `seats` (the Seat Map changed —
 * refetch GET …/seats; the event carries no seat payload so no per-viewer
 * state leaks into cross-viewer broadcasts). Heartbeat comments keep
 * proxies from closing idle connections.
 */
showtimesRouter.get("/:showtimeId/stream", (req, res) => {
  const showtimeId = routeParam(req, "showtimeId");
  if (!getCatalog().showtimeById(showtimeId)) throw ApiError.notFound("Showtime not found");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: ready\ndata: {"ok":true}\n\n`);

  const unsubscribe = getSeatBus().subscribe(showtimeId, () => {
    res.write(`event: seats\ndata: {"ts":${Date.now()}}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);
  heartbeat.unref?.();

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** Locks the chosen seats for 5 minutes so nobody else can take them. */
showtimesRouter.post(
  "/:showtimeId/holds",
  validate(seatSelectionSchema),
  asyncHandler(async (req, res) => {
    const { seatIds } = req.body as z.infer<typeof seatSelectionSchema>;
    res.json(await holdSeats(routeParam(req, "showtimeId"), seatIds, viewerFrom(req)));
  }),
);

showtimesRouter.delete(
  "/:showtimeId/holds",
  asyncHandler(async (req, res) => {
    await releaseHolds(routeParam(req, "showtimeId"), viewerFrom(req));
    res.status(204).end();
  }),
);
