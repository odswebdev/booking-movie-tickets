import { describe, expect, it } from "vitest";
import type { City } from "@shared/types";
import { resolveCityId } from "./city";

const CITIES: City[] = [
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

describe("resolveCityId", () => {
  it("returns null when no cities are served", () => {
    expect(resolveCityId({ cities: [] })).toBeNull();
  });

  it("prefers the stored choice over geo detection", () => {
    expect(resolveCityId({ cities: CITIES, storedCityId: "msk", detectedCityId: "nyc" })).toBe("msk");
  });

  it("falls back to the detected city when nothing is stored", () => {
    expect(resolveCityId({ cities: CITIES, detectedCityId: "msk" })).toBe("msk");
  });

  it("ignores stored and detected ids that are not served", () => {
    expect(resolveCityId({ cities: CITIES, storedCityId: "london", detectedCityId: "paris" })).toBe("nyc");
  });

  it("defaults to the first served city", () => {
    expect(resolveCityId({ cities: CITIES })).toBe("nyc");
  });
});
