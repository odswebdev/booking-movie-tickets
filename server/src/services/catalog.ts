import {
  HALL_AISLES_AFTER,
  HALL_LAYOUT,
  seatClassForRow,
  seatId,
  seatLabel,
  seatPriceCents,
} from "../../../shared/hall.js";
import { SEAT_CLASS_PRICES_CENTS } from "../../../shared/pricing.js";
import type {
  Locale,
  Movie,
  ScreeningDay,
  ScreeningTime,
  Showtime,
  Theater,
  TheaterScreenings,
} from "../../../shared/types.js";
import { THEATER_TIMEZONE } from "../../../shared/cinema.js";
import { env } from "../config/env.js";
import type {
  StoredCatalog,
  StoredCinema,
  StoredHall,
  StoredMovie,
  StoredScreening,
  StoredSeat,
} from "../db/schema.js";
import { getRepositories } from "../db/provider.js";
import { hashString, seededRandom } from "../utils/ids.js";
import { addDays, formatDateKeyLabel, localToUtc, toDateKey } from "../utils/time.js";
import { CITIES } from "../geo/cities.js";
import { getTmdbCatalog } from "./tmdb.js";
import { logger } from "../utils/logger.js";

/**
 * Catalog (ТЗ §2): movies, cities, cinemas, halls, seats and screenings live in
 * the database now — `generateSnapshot()` builds the demo catalogue, the
 * repository persists it and every read afterwards is a plain query.
 *
 * The runtime `Catalog` object is still an in-memory index (seat lookups and
 * screenings are read on almost every request); it is rebuilt whenever the
 * cinema-local date rolls over, and the fresh snapshot is written back to the
 * database in the background.
 */

/** How many days ahead customers may book (ТЗ: a 14-day calendar). */
export const BOOKING_WINDOW_DAYS = env.CATALOG_WINDOW_DAYS;
/** Bookings close this many minutes before the show starts. */
export const BOOKING_CUTOFF_MINUTES = 15;

/** Bundled catalog: used when TMDB is not configured or unreachable. */
const LOCAL_MOVIES: Movie[] = [
  {
    id: "mv_furiosa",
    slug: "furiosa",
    title: "Furiosa: A Mad Max Saga",
    synopsis:
      "As the world falls, young Furiosa is snatched from the Green Place of Many Mothers and falls into the hands of a great biker horde. Sweeping through the Wasteland, she plots a route home.",
    posterUrl: "/posters/furiosa.png",
    backdropUrl: null,
    durationMinutes: 148,
    genres: ["Action", "Adventure", "Sci-Fi"],
    rating: "R",
    releaseYear: 2024,
    releaseDate: "2024-05-23",
    voteAverage: 7.6,
    isNew: false,
    discountPercent: 20,
    trailerUrl: "https://www.youtube.com/watch?v=XJMuhwVlca4",
    localized: {
      ru: {
        title: "Фуриоса: Безумный Макс. Сага",
        synopsis:
          "Пока мир рушится, юную Фуриосу похищают из Зелёной Земли Множества Матерей и бросают в руки свирепой байкерской орды. Скитаясь по Пустошам, она прокладывает путь домой.",
      },
    },
    source: "local",
  },
  {
    id: "mv_if",
    slug: "if",
    title: "IF",
    synopsis:
      "A girl who can see everyone's imaginary friends embarks on a magical adventure to reconnect forgotten IFs with their kids.",
    posterUrl: "/posters/if.png",
    backdropUrl: null,
    durationMinutes: 104,
    genres: ["Animation", "Comedy", "Family"],
    rating: "PG",
    releaseYear: 2024,
    releaseDate: "2024-05-16",
    voteAverage: 7.1,
    isNew: false,
    discountPercent: 0,
    trailerUrl: "https://www.youtube.com/watch?v=mb2187Z1BkQ",
    localized: {
      ru: {
        title: "Воображаемые друзья",
        synopsis:
          "Девочка, которая видит воображаемых друзей всех вокруг, отправляется в волшебное путешествие, чтобы снова соединить забытых друзей с их детьми.",
      },
    },
    source: "local",
  },
  {
    id: "mv_civil_war",
    slug: "civil-war",
    title: "Civil War",
    synopsis:
      "A team of military-embedded journalists races across a fractured United States as the nation spirals into its final days.",
    posterUrl: "/posters/civil-war.png",
    backdropUrl: null,
    durationMinutes: 109,
    genres: ["Action", "Drama", "Thriller"],
    rating: "R",
    releaseYear: 2024,
    releaseDate: "2024-04-11",
    voteAverage: 7.0,
    isNew: false,
    discountPercent: 10,
    trailerUrl: "https://www.youtube.com/watch?v=aDyQxtg0V2w",
    localized: {
      ru: {
        title: "Гражданская война",
        synopsis:
          "Команда военных журналистов мчится через расколотую страну, где каждый день может стать последним.",
      },
    },
    source: "local",
  },
  {
    id: "mv_planet_apes",
    slug: "kingdom-of-the-planet-of-the-apes",
    title: "Kingdom of the Planet of the Apes",
    synopsis:
      "Many generations after Caesar's reign, a young ape goes on a journey that will lead him to question everything he has been taught about the past.",
    posterUrl: "/posters/planet-apes.png",
    backdropUrl: null,
    durationMinutes: 145,
    genres: ["Action", "Adventure", "Sci-Fi"],
    rating: "PG-13",
    releaseYear: 2024,
    releaseDate: "2024-05-09",
    voteAverage: 7.3,
    isNew: false,
    discountPercent: 0,
    trailerUrl: "https://www.youtube.com/watch?v=Kdr5oedn7q8",
    localized: {
      ru: {
        title: "Планета обезьян: Новое царство",
        synopsis:
          "Спустя многие поколения после Цезаря молодой шимпанзе отправляется в путь, который заставит его усомниться во всём, чему его учили о прошлом.",
      },
    },
    source: "local",
  },
  {
    id: "mv_dune_two",
    slug: "dune-part-two",
    title: "Dune: Part Two",
    synopsis:
      "Paul Atreides unites with the Fremen to wage war against House Harkonnen, walking the path toward a destiny he has fought to avoid.",
    posterUrl: "/posters/dune.png",
    backdropUrl: null,
    durationMinutes: 166,
    genres: ["Adventure", "Drama", "Sci-Fi"],
    rating: "PG-13",
    releaseYear: 2024,
    releaseDate: "2024-02-27",
    voteAverage: 8.2,
    isNew: false,
    discountPercent: 15,
    trailerUrl: "https://www.youtube.com/watch?v=Way9Dexny3w",
    localized: {
      ru: {
        title: "Дюна: Часть вторая",
        synopsis:
          "Пол Атрейдес объединяется с фрименами, чтобы пойти войной на дом Харконненов и принять судьбу, которой он пытался избежать.",
      },
    },
    source: "local",
  },
  {
    id: "mv_sheriff",
    slug: "sheriff",
    title: "Sheriff",
    synopsis:
      "A no-nonsense sheriff hunting a meticulous serial killer discovers the investigation leads far closer to home than he ever expected.",
    posterUrl: "/posters/sheriff.png",
    backdropUrl: null,
    durationMinutes: 118,
    genres: ["Action", "Crime", "Thriller"],
    rating: "PG-13",
    releaseYear: 2024,
    releaseDate: "2024-08-15",
    voteAverage: 6.8,
    isNew: true,
    discountPercent: 0,
    trailerUrl: null,
    localized: {
      ru: {
        title: "Шериф",
        synopsis:
          "Бескомпромиссный шериф, охотящийся за педантичным маньяком, обнаруживает, что следы ведут куда ближе к дому, чем он мог представить.",
      },
    },
    source: "local",
  },
];

/** Cinemas are localised: Moscow theatres for Russian, New York for English. */
const THEATERS: Theater[] = [
  {
    id: "th_ny_empire",
    name: "AMC Empire 25",
    city: "New York",
    cityId: "nyc",
    address: "234 W 42nd St, New York, NY 10036",
    coordinates: { lat: 40.7568, lng: -73.9888 },
    locale: "en",
  },
  {
    id: "th_ny_union",
    name: "Regal Union Square",
    city: "New York",
    cityId: "nyc",
    address: "850 Broadway, New York, NY 10003",
    coordinates: { lat: 40.7357, lng: -73.9907 },
    locale: "en",
  },
  {
    id: "th_ny_brooklyn",
    name: "Alamo Drafthouse Brooklyn",
    city: "New York",
    cityId: "nyc",
    address: "445 Albee Square W, Brooklyn, NY 11201",
    coordinates: { lat: 40.6915, lng: -73.985 },
    locale: "en",
  },
  {
    id: "th_msk_oktyabr",
    name: "«Октябрь» Каро 11",
    city: "Москва",
    cityId: "msk",
    address: "ул. Новый Арбат, 24, Москва",
    coordinates: { lat: 55.7522, lng: 37.5856 },
    locale: "ru",
  },
  {
    id: "th_msk_kutuzovsky",
    name: "Формула Кино Кутузовский",
    city: "Москва",
    cityId: "msk",
    address: "Кутузовский проспект, 57, Москва",
    coordinates: { lat: 55.7387, lng: 37.5297 },
    locale: "ru",
  },
  {
    id: "th_msk_metropolis",
    name: "Синема Парк Метрополис",
    city: "Москва",
    cityId: "msk",
    address: "Ленинградское шоссе, 16А, Москва",
    coordinates: { lat: 55.8227, lng: 37.496 },
    locale: "ru",
  },
];

const SHOW_SLOTS = ["10:30", "12:45", "14:00", "16:15", "18:30", "20:00", "21:45"];
const HALLS = ["Hall 1", "Hall 2", "Hall 3", "Hall 4"];
const HALL_FORMATS = ["2D", "2D", "3D", "IMAX"];

export function hallIdFor(cinemaId: string, hallNumber: number): string {
  return `${cinemaId}_h${hallNumber}`;
}

/** Cinema-local "today" for both served cities (the window follows the cinema). */
function dateKeysNow(now: Date): { en: string; ru: string } {
  return { en: toDateKey(now, THEATER_TIMEZONE.en), ru: toDateKey(now, THEATER_TIMEZONE.ru) };
}

/**
 * Builds the full catalog snapshot (the shape the DB stores): cities, cinemas,
 * halls, seats, movies and screenings for the whole bookable window.
 */
export function generateSnapshot(now: Date, movies: Movie[]): StoredCatalog {
  const cinemaBySlugCity = new Map(CITIES.map((city) => [city.id, city]));

  const cities = CITIES.map((city) => ({
    id: city.id,
    slug: city.id,
    countryCode: city.countryCode,
    currency: city.currency,
    nameRu: city.names.ru,
    nameEn: city.names.en,
    lat: city.center.lat,
    lng: city.center.lng,
  }));

  const cinemas: StoredCinema[] = THEATERS.map((theater) => {
    const localizedEn = theater.localized?.en;
    const localizedRu = theater.localized?.ru;
    return {
      id: theater.id,
      slug: theater.id.replace(/^th_/, ""),
      cityId: theater.cityId,
      nameRu: localizedRu?.name ?? theater.name,
      nameEn: localizedEn?.name ?? theater.name,
      addressRu: localizedRu?.address ?? theater.address,
      addressEn: localizedEn?.address ?? theater.address,
      lat: theater.coordinates?.lat ?? cinemaBySlugCity.get(theater.cityId)?.center.lat ?? 0,
      lng: theater.coordinates?.lng ?? cinemaBySlugCity.get(theater.cityId)?.center.lng ?? 0,
      locale: theater.locale,
    };
  });

  const halls: StoredHall[] = [];
  const seats: StoredSeat[] = [];
  for (const cinema of cinemas) {
    for (let number = 1; number <= HALLS.length; number += 1) {
      const hall: StoredHall = {
        id: hallIdFor(cinema.id, number),
        cinemaId: cinema.id,
        nameRu: `Зал ${number}`,
        nameEn: HALLS[number - 1] ?? `Hall ${number}`,
        format: HALL_FORMATS[number - 1] ?? "2D",
        rows: HALL_LAYOUT.rows.length,
        columns: HALL_LAYOUT.columns,
        aislesAfter: [...HALL_AISLES_AFTER],
        classesByRow: { ...HALL_LAYOUT.classesByRow },
      };
      halls.push(hall);
      for (const row of HALL_LAYOUT.rows) {
        for (let column = 1; column <= HALL_LAYOUT.columns; column += 1) {
          const seatClass = seatClassForRow(row);
          seats.push({
            id: `${hall.id}_${seatId(row, column)}`,
            hallId: hall.id,
            row,
            number: column,
            seatClass,
            priceDeltaCents: seatPriceCents(row) - SEAT_CLASS_PRICES_CENTS.standard,
          });
        }
      }
    }
  }

  const storedMovies: StoredMovie[] = movies.map((movie) => ({
    id: movie.id,
    slug: movie.slug,
    titleRu: movie.localized?.ru?.title ?? movie.title,
    titleEn: movie.title,
    synopsisRu: movie.localized?.ru?.synopsis ?? movie.synopsis,
    synopsisEn: movie.synopsis,
    posterUrl: movie.posterUrl,
    backdropUrl: movie.backdropUrl ?? null,
    trailerUrl: movie.trailerUrl ?? null,
    durationMinutes: movie.durationMinutes,
    genresRu: movie.genres,
    genresEn: movie.genres,
    ageRating: movie.rating,
    releaseYear: movie.releaseYear,
    releaseDate: movie.releaseDate ?? null,
    voteAverage: movie.voteAverage ?? null,
    isNew: movie.isNew ?? false,
    discountPercent: movie.discountPercent ?? 0,
    badges: [...(movie.isNew ? ["NEW"] : []), ...(movie.discountPercent ? ["PROMO"] : [])],
    source: movie.source ?? "local",
  }));

  const screenings: StoredScreening[] = [];
  for (const movie of movies) {
    for (const theater of THEATERS) {
      const timeZone = THEATER_TIMEZONE[theater.locale];
      const startKey = toDateKey(now, timeZone);
      for (let dayOffset = 0; dayOffset < BOOKING_WINDOW_DAYS; dayOffset += 1) {
        const dateKey = addDays(startKey, dayOffset);
        const rng = seededRandom(hashString(`${movie.id}|${theater.id}|${dateKey}`));
        const slotCount = 3 + Math.floor(rng() * 2); // 3–4 shows per day
        const startIndex = Math.floor(rng() * (SHOW_SLOTS.length - slotCount));
        const slots = SHOW_SLOTS.slice(startIndex, startIndex + slotCount);
        const hallNumber = (hashString(`${movie.id}|${theater.id}`) % HALLS.length) + 1;

        for (const time of slots) {
          const startsAt = localToUtc(dateKey, time, timeZone);
          const endsAt = new Date(startsAt.getTime() + movie.durationMinutes * 60_000);
          screenings.push({
            id: `st_${movie.id}_${theater.id}_${dateKey}_${time.replace(":", "")}`,
            movieId: movie.id,
            hallId: hallIdFor(theater.id, hallNumber),
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            date: dateKey,
            time,
            timeZone,
            basePriceCents: SEAT_CLASS_PRICES_CENTS.standard,
            currency: "USD",
          });
        }
      }
    }
  }

  screenings.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { cities, cinemas, halls, seats, movies: storedMovies, screenings };
}

/** True while the snapshot still covers the whole bookable window. */
export function snapshotIsFresh(snapshot: StoredCatalog, now: Date = new Date()): boolean {
  if (snapshot.screenings.length === 0) return false;
  const dates = new Set(snapshot.screenings.map((screening) => screening.date));
  for (const zone of Object.values(THEATER_TIMEZONE)) {
    const startKey = toDateKey(now, zone);
    const endKey = addDays(startKey, BOOKING_WINDOW_DAYS - 1);
    if (!dates.has(startKey) || !dates.has(endKey)) return false;
  }
  return true;
}

/* --------------------------------------------------------------------------
 * Runtime index built from the stored snapshot
 * ------------------------------------------------------------------------ */

function movieFromStored(stored: StoredMovie): Movie {
  const localized =
    stored.titleRu !== stored.titleEn || stored.synopsisRu !== stored.synopsisEn
      ? { ru: { title: stored.titleRu, synopsis: stored.synopsisRu } }
      : undefined;
  return {
    id: stored.id,
    slug: stored.slug,
    title: stored.titleEn,
    synopsis: stored.synopsisEn,
    posterUrl: stored.posterUrl,
    backdropUrl: stored.backdropUrl,
    trailerUrl: stored.trailerUrl,
    durationMinutes: stored.durationMinutes,
    genres: stored.genresEn,
    rating: stored.ageRating as Movie["rating"],
    releaseYear: stored.releaseYear,
    releaseDate: stored.releaseDate,
    voteAverage: stored.voteAverage,
    isNew: stored.isNew,
    discountPercent: stored.discountPercent,
    localized,
    source: stored.source,
  };
}

function theaterFromStored(stored: StoredCinema): Theater {
  const name = stored.locale === "ru" ? stored.nameRu : stored.nameEn;
  const address = stored.locale === "ru" ? stored.addressRu : stored.addressEn;
  const other: Locale = stored.locale === "ru" ? "en" : "ru";
  const otherName = other === "ru" ? stored.nameRu : stored.nameEn;
  const otherAddress = other === "ru" ? stored.addressRu : stored.addressEn;
  return {
    id: stored.id,
    name,
    city: stored.locale === "ru" ? "Москва" : "New York",
    cityId: stored.cityId,
    address,
    coordinates: stored.lat !== 0 || stored.lng !== 0 ? { lat: stored.lat, lng: stored.lng } : undefined,
    locale: stored.locale,
    localized:
      otherName === name
        ? undefined
        : {
            [other]: { name: otherName, city: other === "ru" ? "Москва" : "New York", address: otherAddress },
          },
  };
}

/** Rebuilds the in-memory catalog index from a stored snapshot. */
export function catalogFromSnapshot(snapshot: StoredCatalog): Catalog {
  const cinemasById = new Map(snapshot.cinemas.map((cinema) => [cinema.id, cinema]));
  const movies = snapshot.movies.map(movieFromStored);
  const theaters = snapshot.cinemas.map(theaterFromStored);
  const hallNames = new Map(snapshot.halls.map((hall) => [hall.id, hall.nameEn]));

  const showtimes: Showtime[] = snapshot.screenings.map((screening) => {
    const cinemaId = snapshot.halls.find((hall) => hall.id === screening.hallId)?.cinemaId ?? "";
    const cinema = cinemasById.get(cinemaId);
    return {
      id: screening.id,
      movieId: screening.movieId,
      theaterId: cinemaId,
      theaterName: cinema?.nameEn ?? "",
      hall: hallNames.get(screening.hallId) ?? "Hall 1",
      startsAt: screening.startsAt,
      endsAt: screening.endsAt,
      date: screening.date,
      time: screening.time,
      timeZone: screening.timeZone,
      currency: screening.currency,
      fromPriceCents: screening.basePriceCents,
    };
  });

  const startDateKey = dateKeysNow(new Date(snapshot.screenings[0]?.startsAt ?? Date.now())).en;
  return new Catalog(startDateKey, movies, theaters, showtimes);
}

/**
 * Deterministic "already sold" seats so a fresh install still looks like a real
 * cinema. Stable for a given showtime id, so it never flickers between requests.
 */
export function preSoldSeatIds(showtimeId: string): Set<string> {
  const rng = seededRandom(hashString(`sold|${showtimeId}`));
  const sold = new Set<string>();
  const { rows, columns } = HALL_LAYOUT;
  for (const row of rows) {
    for (let number = 1; number <= columns; number += 1) {
      const middleBias = row >= "C" && row <= "F" ? 0.34 : 0.18;
      if (rng() < middleBias) {
        sold.add(seatId(row, number));
      }
    }
  }
  return sold;
}

export function seatMeta(row: string, number: number) {
  const seatClass = seatClassForRow(row);
  return {
    id: seatId(row, number),
    row,
    number,
    label: seatLabel(row, number),
    seatClass,
    priceCents: seatPriceCents(row),
  };
}

/** Rebuild key: changes when either city rolls over to a new day. */
function cacheKey(now: Date): string {
  const keys = dateKeysNow(now);
  return `${keys.en}|${keys.ru}`;
}

export class Catalog {
  public readonly theaters: Theater[];
  public readonly showtimes: Showtime[];
  private readonly showtimesById = new Map<string, Showtime>();
  private readonly moviesById = new Map<string, Movie>();

  constructor(
    public readonly startDateKey: string,
    public readonly movies: Movie[],
    theaters: Theater[],
    showtimes: Showtime[],
  ) {
    this.theaters = theaters;
    this.showtimes = showtimes;
    for (const movie of movies) this.moviesById.set(movie.id, movie);
    for (const showtime of showtimes) this.showtimesById.set(showtime.id, showtime);
  }

  static build(now: Date, snapshot: StoredCatalog): Catalog {
    const catalog = catalogFromSnapshot(snapshot);
    return new Catalog(cacheKey(now), catalog.movies, catalog.theaters, catalog.showtimes);
  }

  movieById(id: string): Movie | undefined {
    return this.moviesById.get(id);
  }

  movieBySlug(slug: string): Movie | undefined {
    return this.movies.find((movie) => movie.slug === slug);
  }

  theaterById(id: string): Theater | undefined {
    return this.theaters.find((theater) => theater.id === id);
  }

  theatersForLocale(locale?: Locale): Theater[] {
    return locale ? this.theaters.filter((theater) => theater.locale === locale) : this.theaters;
  }

  showtimeById(id: string): Showtime | undefined {
    return this.showtimesById.get(id);
  }

  /** Only showtimes that can still be booked (past the cutoff are hidden). */
  listShowtimes(filter: { movieId?: string; theaterId?: string; date?: string } = {}): Showtime[] {
    const cutoff = Date.now() + BOOKING_CUTOFF_MINUTES * 60_000;
    return this.showtimes.filter((showtime) => {
      if (new Date(showtime.startsAt).getTime() < cutoff) return false;
      if (filter.movieId && showtime.movieId !== filter.movieId) return false;
      if (filter.theaterId && showtime.theaterId !== filter.theaterId) return false;
      if (filter.date && showtime.date !== filter.date) return false;
      return true;
    });
  }

  /** Theatres + dates + times available for one movie, grouped for the UI. */
  screeningsForMovie(movieId: string, locale?: Locale): TheaterScreenings[] {
    const showtimes = this.listShowtimes({ movieId });
    return this.theatersForLocale(locale)
      .map((theater) => {
        const byDate = new Map<string, ScreeningTime[]>();
        for (const showtime of showtimes) {
          if (showtime.theaterId !== theater.id) continue;
          const list = byDate.get(showtime.date) ?? [];
          list.push({
            showtimeId: showtime.id,
            time: showtime.time,
            hall: showtime.hall,
            fromPriceCents: showtime.fromPriceCents,
            seatsLeft: 0, // filled by the route, which has live seat data
          });
          byDate.set(showtime.date, list);
        }
        const days: ScreeningDay[] = [...byDate.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, times]) => ({
            date,
            label: formatDateKeyLabel(date, THEATER_TIMEZONE[theater.locale]),
            times: times.sort((a, b) => a.time.localeCompare(b.time)),
          }));
        return { theater, days };
      })
      .filter((entry) => entry.days.length > 0)
      .sort((a, b) => a.theater.name.localeCompare(b.theater.name));
  }

  /** Every date that has at least one showtime, across all movies. */
  availableDates(): string[] {
    const dates = new Set(this.listShowtimes().map((showtime) => showtime.date));
    return [...dates].sort();
  }

  /**
   * Movies with at least one bookable showtime, newest first. When a locale is
   * given, only movies playing in that locale's theatres are returned (Moscow
   * cinemas for RU, New York for EN).
   */
  nowShowing(locale?: Locale): Movie[] {
    if (!locale) {
      const withShows = new Set(this.listShowtimes().map((showtime) => showtime.movieId));
      return this.movies.filter((movie) => withShows.has(movie.id));
    }
    const theaterIds = new Set(this.theatersForLocale(locale).map((theater) => theater.id));
    const forLocale = new Set(
      this.listShowtimes()
        .filter((showtime) => theaterIds.has(showtime.theaterId))
        .map((showtime) => showtime.movieId),
    );
    return this.movies.filter((movie) => forLocale.has(movie.id));
  }
}

let cached: Catalog | null = null;
let currentMovies: Movie[] = LOCAL_MOVIES;
let catalogSource: "tmdb" | "local" = "local";
/**
 * Last persist in flight — kept so tests and graceful shutdown can await the
 * rollover write instead of racing it.
 */
export let catalogPersistInFlight: Promise<void> | null = null;

/** Writes the snapshot to the database without blocking the request path. */
function persistSnapshot(snapshot: StoredCatalog): void {
  catalogPersistInFlight = getRepositories()
    .catalog.replace(snapshot)
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.warn({ err: error }, "catalog persistence failed — serving in-memory catalog");
    });
}

/**
 * Bootstrap: pick the movie source (TMDB when keyed), load the snapshot from
 * the database and re-seed it whenever the bookable window has rolled over or
 * nothing was stored yet.
 */
export async function initCatalog(now: Date = new Date()): Promise<Catalog> {
  try {
    const tmdbMovies = await getTmdbCatalog();
    if (tmdbMovies.length > 0) {
      currentMovies = tmdbMovies;
      catalogSource = "tmdb";
      logger.info({ movies: tmdbMovies.length }, "catalog loaded from TMDB");
    } else {
      catalogSource = "local";
      logger.info("using bundled catalog (TMDB unavailable or not configured)");
    }
  } catch (error) {
    logger.warn({ err: error }, "catalog initialisation failed — using bundled catalog");
  }

  let snapshot: StoredCatalog | null = null;
  try {
    snapshot = await getRepositories().catalog.load();
  } catch (error) {
    logger.warn({ err: error }, "catalog load failed — rebuilding in memory");
  }

  if (!snapshot || !snapshotIsFresh(snapshot, now)) {
    const fresh = generateSnapshot(now, currentMovies);
    snapshot = fresh;
    try {
      await getRepositories().catalog.replace(fresh);
      logger.info(
        { movies: fresh.movies.length, screenings: fresh.screenings.length, days: BOOKING_WINDOW_DAYS },
        "catalog seeded into the database",
      );
    } catch (error) {
      logger.warn({ err: error }, "catalog seed failed — serving in-memory catalog");
    }
  }

  cached = Catalog.build(now, snapshot);
  return cached;
}

export function catalogSourceName(): "tmdb" | "local" {
  return catalogSource;
}

/** Test/ops helper: force a regeneration of the stored snapshot. */
export async function reseedCatalog(now: Date = new Date()): Promise<Catalog> {
  const snapshot = generateSnapshot(now, currentMovies);
  await getRepositories().catalog.replace(snapshot);
  cached = Catalog.build(now, snapshot);
  return cached;
}

/**
 * The catalog is derived from "today", so it is rebuilt whenever the cinema-local
 * date rolls over — a long running server must never serve yesterday's shows.
 * The rebuild is synchronous in memory; the refreshed window is written to the
 * database in the background.
 */
export function getCatalog(now: Date = new Date()): Catalog {
  if (!cached || cached.startDateKey !== cacheKey(now)) {
    const snapshot = generateSnapshot(now, currentMovies);
    cached = Catalog.build(now, snapshot);
    persistSnapshot(snapshot);
  }
  return cached;
}
