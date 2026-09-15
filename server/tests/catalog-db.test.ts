import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { setupTestApp, teardownTestApp, type TestContext } from "./setup.js";

/**
 * Catalog in the database (ТЗ §2 + §5): the generated snapshot (cities,
 * cinemas, halls, seats, movies, screenings) is persisted through the
 * repository and served from there, with a 14-day bookable window.
 */
describe("catalog persisted in the database", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestApp("catalog-db-");
  });

  afterEach(async () => {
    await teardownTestApp(ctx.tempDir);
  });

  it("seeds cities, cinemas, halls, seats, movies and screenings on boot", async () => {
    const { getRepositories } = await import("../src/db/provider.js");
    const repos = getRepositories();

    const snapshot = await repos.catalog.load();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.cities.length).toBeGreaterThanOrEqual(2);
    expect(snapshot?.cinemas.length).toBeGreaterThanOrEqual(6);
    expect(snapshot?.halls.length).toBeGreaterThanOrEqual(6 * 4);
    // 8 rows × 12 columns per hall.
    expect(snapshot?.seats.length).toBe(snapshot!.halls.length * 96);
    expect(snapshot?.movies.length).toBeGreaterThanOrEqual(6);
    expect(snapshot?.screenings.length).toBeGreaterThan(100);

    const cinema = snapshot?.cinemas[0];
    expect(cinema?.nameEn).toBeTruthy();
    expect(cinema?.addressRu).toBeTruthy();

    const hall = snapshot?.halls.find((entry) => entry.cinemaId === cinema?.id);
    expect(hall?.rows).toBe(8);
    expect(hall?.columns).toBe(12);
    expect(Object.keys(hall?.classesByRow ?? {})).toContain("G");
  });

  it("publishes a 14-day bookable window per cinema timezone", async () => {
    const movies = await request(ctx.app).get("/api/movies").expect(200);
    const slug = movies.body.items[0].slug as string;

    const detail = await request(ctx.app).get(`/api/movies/${slug}`).expect(200);
    const screenings = detail.body.screenings as Array<{ days: Array<{ date: string }> }>;
    expect(screenings.length).toBeGreaterThan(0);

    // Every cinema publishes the 14-day window starting at its own local
    // "today". Near local midnight the two cities straddle two calendar dates,
    // and late in a local day the first date's shows are already past the
    // booking cutoff — so assert the window shape, not one fixed count.
    for (const entry of screenings) {
      const days = entry.days.map((day) => day.date);
      expect(days.length).toBeGreaterThanOrEqual(13);
      expect(days.length).toBeLessThanOrEqual(14);
      for (let i = 1; i < days.length; i += 1) {
        const gap = Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`);
        expect(gap).toBe(86_400_000); // consecutive local dates
      }
    }

    // Union across New York (UTC-4/5) and Moscow (UTC+3): 14 dates normally,
    // 15 while their local midnights straddle "now".
    const dates: string[] = detail.body.dates;
    expect(dates.length).toBeGreaterThanOrEqual(13);
    expect(dates.length).toBeLessThanOrEqual(15);

    // The window starts "today" in each cinema's own timezone.
    const { THEATER_TIMEZONE } = await import("../../shared/cinema.js");
    const { getCatalog } = await import("../src/services/catalog.js");
    const catalog = getCatalog();
    const zones = new Set(catalog.showtimes.map((showtime) => showtime.timeZone));
    expect(zones).toEqual(new Set([THEATER_TIMEZONE.en, THEATER_TIMEZONE.ru]));
  });

  it("serves showtimes from the stored screenings (ids and prices round-trip)", async () => {
    const { getCatalog } = await import("../src/services/catalog.js");
    const { getRepositories } = await import("../src/db/provider.js");
    const snapshot = await getRepositories().catalog.load();
    const stored = snapshot!.screenings[0]!;

    const catalog = getCatalog();
    const showtime = catalog.showtimeById(stored.id);
    expect(showtime).toBeDefined();
    expect(showtime?.startsAt).toBe(stored.startsAt);
    expect(showtime?.fromPriceCents).toBe(stored.basePriceCents);
    expect(showtime?.hall).toMatch(/^Hall \d$/);

    const response = await request(ctx.app).get(`/api/showtimes/${stored.id}`).expect(200);
    expect(response.body.showtime.id).toBe(stored.id);
    expect(response.body.seatsLeft).toBeGreaterThanOrEqual(0);
  });

  it("exposes trailers only for movies that have one, with a usable seat map", async () => {
    const movies = await request(ctx.app).get("/api/movies").expect(200);
    const items = movies.body.items as Array<{ trailerUrl?: string }>;
    const withTrailer = items.filter((movie) => Boolean(movie.trailerUrl));
    expect(withTrailer.length).toBeGreaterThan(0);
    for (const movie of withTrailer) {
      expect(movie.trailerUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    }

    const showtimes = await request(ctx.app).get("/api/showtimes").expect(200);
    const firstShowtime = (showtimes.body.items as Array<{ id: string }>)[0]!;
    const seatMap = await request(ctx.app).get(`/api/showtimes/${firstShowtime.id}/seats`).expect(200);
    expect(seatMap.body.capacity).toBe(96);
    expect(seatMap.body.seats[0]).toMatchObject({ row: "A", number: 1, seatClass: "standard" });
  });
});
