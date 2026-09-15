import type { City } from "@shared/types";

const CITY_STORAGE_KEY = "movie-tickets.cityId";

/** Explicit city choice from a previous visit (null when never chosen). */
export function loadStoredCityId(): string | null {
  try {
    return window.localStorage.getItem(CITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persists the visitor's explicit city choice (best effort). */
export function saveStoredCityId(cityId: string): void {
  try {
    window.localStorage.setItem(CITY_STORAGE_KEY, cityId);
  } catch {
    // Private mode etc. — the page works fine without persistence.
  }
}

/**
 * Default city for the cinemas page: the stored choice wins, then the
 * geo-detected city (when it is served), then the first served city.
 * Always returns a served id (or null when no cities are served).
 */
export function resolveCityId(options: {
  cities: City[];
  storedCityId?: string | null;
  detectedCityId?: string | null;
}): string | null {
  const { cities, storedCityId, detectedCityId } = options;
  if (storedCityId && cities.some((city) => city.id === storedCityId)) return storedCityId;
  if (detectedCityId && cities.some((city) => city.id === detectedCityId)) return detectedCityId;
  return cities[0]?.id ?? null;
}
