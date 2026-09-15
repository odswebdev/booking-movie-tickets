import type { City } from "../../../shared/types.js";
import type { GeoLookup } from "./types.js";

/** Served cities (grows with the catalog; the DB catalog will own this table). */
export const CITIES: City[] = [
  {
    id: "nyc",
    countryCode: "US",
    currency: "USD",
    center: { lat: 40.7128, lng: -74.006 },
    names: { en: "New York", ru: "Нью-Йорк" },
  },
  {
    id: "msk",
    countryCode: "RU",
    currency: "RUB",
    center: { lat: 55.7558, lng: 37.6173 },
    names: { en: "Moscow", ru: "Москва" },
  },
];

export const DEFAULT_CITY_ID = "nyc";

export function cityById(id: string): City | undefined {
  return CITIES.find((city) => city.id === id);
}

export function mustCityById(id: string): City {
  const city = cityById(id);
  if (!city) throw new Error(`unknown city: ${id}`);
  return city;
}

/** Country fallback for a two-city catalog (CIS → Moscow, world → New York). */
const MOSCOW_COUNTRIES = new Set(["RU", "BY", "KZ", "AM", "AZ", "GE", "KG", "MD", "TJ", "UZ"]);

/** Maps a raw geo lookup onto a served city (exact name match, then country). */
export function resolveServedCityId(lookup: GeoLookup | null): string {
  if (lookup) {
    const city = lookup.city?.toLowerCase().replace(/ё/g, "е") ?? "";
    if (city.includes("moscow") || city.includes("москв")) return "msk";
    if (city.includes("new york") || city.includes("нью-йорк") || city.includes("нью йорк")) return "nyc";
    if (lookup.countryCode && MOSCOW_COUNTRIES.has(lookup.countryCode.toUpperCase())) return "msk";
  }
  return DEFAULT_CITY_ID;
}
