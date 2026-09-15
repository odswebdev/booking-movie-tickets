import type { Locale, Movie } from "../../../shared/types.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { hashString, seededRandom } from "../utils/ids.js";

/**
 * Optional catalog provider: The Movie Database (https://www.themoviedb.org).
 *
 * Set TMDB_API_KEY to stream real "now playing" movies (title, poster, overview,
 * rating, release date) in every language you list in TMDB_LOCALES. Without a
 * key the bundled catalog is used, so the app always boots.
 */
const API_ROOT = "https://api.themoviedb.org/3";
const LOCALES: Locale[] = ["en", "ru"];
const TMDB_LANGUAGE: Record<Locale, string> = { en: "en-US", ru: "ru-RU" };

interface TmdbMovieSummary {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  vote_average: number;
  genre_ids: number[];
  adult: boolean;
}

interface TmdbListResponse {
  results: TmdbMovieSummary[];
}

interface CacheEntry {
  movies: Movie[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<Movie[]> | null = null;

const NEW_RELEASE_WINDOW_DAYS = 45;
/** How many movies get a detail call (for runtime + genres). */
const DETAIL_LIMIT = 8;

function slugify(value: string, id: number): string {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return `${base || "movie"}-${id}`;
}

function isFreshRelease(releaseDate: string | null): boolean {
  if (!releaseDate) return false;
  const released = new Date(`${releaseDate}T00:00:00Z`).getTime();
  if (Number.isNaN(released)) return false;
  const ageDays = (Date.now() - released) / 86_400_000;
  return ageDays <= NEW_RELEASE_WINDOW_DAYS;
}

/** Deterministic per-movie promotion so badges never flicker between requests. */
function discountFor(id: number): number {
  const roll = seededRandom(hashString(`promo|${id}`))();
  if (roll < 0.18) return 20;
  if (roll < 0.38) return 15;
  if (roll < 0.55) return 10;
  return 0;
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`${API_ROOT}${path}`);
  url.searchParams.set("api_key", env.TMDB_API_KEY ?? "");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.TMDB_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      logger.warn({ status: response.status, path }, "TMDB request failed");
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    logger.warn({ err: error, path }, "TMDB request error");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGenres(): Promise<Map<number, string>> {
  const data = await getJson<{ genres: Array<{ id: number; name: string }> }>("/genre/movie/list", {});
  return new Map((data?.genres ?? []).map((genre) => [genre.id, genre.name]));
}

async function fetchRuntime(id: number): Promise<number | null> {
  const data = await getJson<{ runtime?: number | null }>(`/movie/${id}`, { language: "en-US" });
  return data?.runtime && data.runtime > 40 ? data.runtime : null;
}

/** Fetches "now playing" for one locale and returns raw summaries. */
async function fetchNowPlaying(locale: Locale): Promise<TmdbMovieSummary[]> {
  const data = await getJson<TmdbListResponse>("/movie/now_playing", {
    language: TMDB_LANGUAGE[locale],
    region: env.TMDB_REGION,
    page: "1",
  });
  return (data?.results ?? []).filter((movie) => !movie.adult).slice(0, 12);
}

async function buildCatalog(): Promise<Movie[]> {
  const [english, russian, genres] = await Promise.all([
    fetchNowPlaying("en"),
    fetchNowPlaying("ru"),
    fetchGenres(),
  ]);

  if (english.length === 0) return [];

  const russianById = new Map(russian.map((movie) => [movie.id, movie]));

  const withRuntime = await Promise.all(
    english.slice(0, DETAIL_LIMIT).map(async (movie) => ({
      id: movie.id,
      runtime: await fetchRuntime(movie.id),
    })),
  );
  const runtimeById = new Map(withRuntime.map((entry) => [entry.id, entry.runtime]));

  return english.map((movie) => {
    const localizedRussian = russianById.get(movie.id);
    const discountPercent = discountFor(movie.id);

    return {
      id: `tmdb_${movie.id}`,
      slug: slugify(movie.title, movie.id),
      title: movie.title,
      synopsis: movie.overview || "No synopsis available yet.",
      posterUrl: movie.poster_path ? `${env.TMDB_IMAGE_BASE}/w500${movie.poster_path}` : "",
      backdropUrl: movie.backdrop_path ? `${env.TMDB_IMAGE_BASE}/w780${movie.backdrop_path}` : null,
      durationMinutes: runtimeById.get(movie.id) ?? 120,
      genres: movie.genre_ids.map((id) => genres.get(id)).filter((name): name is string => Boolean(name)),
      rating: movie.adult ? "R" : "PG-13",
      releaseYear: movie.release_date ? Number(movie.release_date.slice(0, 4)) : new Date().getFullYear(),
      releaseDate: movie.release_date,
      voteAverage: movie.vote_average,
      isNew: isFreshRelease(movie.release_date),
      discountPercent,
      localized: localizedRussian
        ? {
            ru: {
              title: localizedRussian.title || movie.title,
              synopsis: localizedRussian.overview || movie.overview,
            },
          }
        : undefined,
      source: "tmdb",
    } satisfies Movie;
  });
}

/**
 * Returns TMDB movies or an empty array (never throws) so the caller can fall
 * back to the bundled catalog. Results are cached and de-duplicated when
 * several requests arrive while the first fetch is still running.
 */
export async function getTmdbCatalog(force = false): Promise<Movie[]> {
  if (!env.TMDB_API_KEY) return [];
  if (!force && cache && Date.now() - cache.fetchedAt < env.TMDB_CACHE_TTL_MS) {
    return cache.movies;
  }
  if (inFlight) return inFlight;

  inFlight = buildCatalog()
    .then((movies) => {
      if (movies.length > 0) {
        cache = { movies, fetchedAt: Date.now() };
      }
      return movies;
    })
    .catch((error) => {
      logger.warn({ err: error }, "TMDB catalog build failed — using bundled catalog");
      return [];
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function tmdbCatalogReady(): boolean {
  return Boolean(cache && cache.movies.length > 0);
}

export const TMDB_LOCALES = LOCALES;
