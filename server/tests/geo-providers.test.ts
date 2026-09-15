import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveServedCityId } from "../src/geo/cities.js";
import { geoProviderName } from "../src/geo/factory.js";
import { __clearRegionCache, isPublicIp, resolveRegion } from "../src/geo/geoService.js";
import { IpApiGeoProvider } from "../src/geo/ipapi.js";
import { MaxmindGeoProvider } from "../src/geo/maxmind.js";
import { MockGeoProvider } from "../src/geo/mock.js";
import { SypexGeoProvider } from "../src/geo/sypex.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __clearRegionCache();
});

function stubFetch(ok: boolean, data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

describe("MockGeoProvider", () => {
  it("places every IP in downtown New York", async () => {
    const lookup = await new MockGeoProvider().resolve("8.8.8.8");
    expect(lookup).toEqual({
      city: "New York",
      countryCode: "US",
      latitude: 40.7128,
      longitude: -74.006,
      currency: "USD",
    });
  });
});

describe("IpApiGeoProvider", () => {
  it("maps the ipapi.co payload onto a lookup", async () => {
    const fetchMock = stubFetch(true, {
      city: "Moscow",
      country_code: "RU",
      latitude: 55.7558,
      longitude: 37.6173,
      currency: "RUB",
    });
    vi.stubGlobal("fetch", fetchMock);

    const lookup = await new IpApiGeoProvider().resolve("1.2.3.4");
    expect(lookup).toEqual({
      city: "Moscow",
      countryCode: "RU",
      latitude: 55.7558,
      longitude: 37.6173,
      currency: "RUB",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://ipapi.co/1.2.3.4/json/");
  });

  it("returns null on HTTP errors, error payloads and fetch failures", async () => {
    vi.stubGlobal("fetch", stubFetch(false, { error: true }, 429));
    await expect(new IpApiGeoProvider().resolve("1.2.3.4")).resolves.toBeNull();

    vi.stubGlobal("fetch", stubFetch(true, { error: true, reason: "RateLimited" }));
    await expect(new IpApiGeoProvider().resolve("1.2.3.4")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(new IpApiGeoProvider().resolve("1.2.3.4")).resolves.toBeNull();
  });
});

describe("SypexGeoProvider", () => {
  it("maps the Sypex payload onto a lookup (no currency)", async () => {
    const fetchMock = stubFetch(true, {
      city: { name_en: "Moscow", lat: 55.7558, lon: 37.6173 },
      country: { iso: "RU" },
    });
    vi.stubGlobal("fetch", fetchMock);

    const lookup = await new SypexGeoProvider().resolve("1.2.3.4");
    expect(lookup).toEqual({
      city: "Moscow",
      countryCode: "RU",
      latitude: 55.7558,
      longitude: 37.6173,
      currency: null,
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.sypexgeo.net/1.2.3.4/json/");
  });

  it("returns null on HTTP errors and fetch failures", async () => {
    vi.stubGlobal("fetch", stubFetch(false, null, 500));
    await expect(new SypexGeoProvider().resolve("1.2.3.4")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(new SypexGeoProvider().resolve("1.2.3.4")).resolves.toBeNull();
  });
});

describe("MaxmindGeoProvider", () => {
  it("refuses to start without a database path", () => {
    expect(() => new MaxmindGeoProvider({ dbPath: "" })).toThrow(/GEO_MMDB_PATH/);
  });

  it("rejects malformed IPs without touching the database", async () => {
    const provider = new MaxmindGeoProvider({ dbPath: "/nonexistent/GeoLite2-City.mmdb" });
    await expect(provider.resolve("not-an-ip")).resolves.toBeNull();
  });
});

describe("resolveServedCityId", () => {
  it.each([["Moscow"], ["MOSCOW"], ["Москва"], ["москва"]])("maps %s onto msk", (city) => {
    expect(
      resolveServedCityId({ city, countryCode: "RU", latitude: null, longitude: null, currency: null }),
    ).toBe("msk");
  });

  it.each([["New York"], ["NEW YORK"], ["Нью-Йорк"], ["нью йорк"]])("maps %s onto nyc", (city) => {
    expect(
      resolveServedCityId({ city, countryCode: "US", latitude: null, longitude: null, currency: null }),
    ).toBe("nyc");
  });

  it("falls back to the country (CIS → Moscow, world → New York)", () => {
    const lookup = (city: string, countryCode: string) => ({
      city,
      countryCode,
      latitude: null,
      longitude: null,
      currency: null,
    });
    expect(resolveServedCityId(lookup("Almaty", "KZ"))).toBe("msk");
    expect(resolveServedCityId(lookup("Minsk", "BY"))).toBe("msk");
    expect(resolveServedCityId(lookup("Paris", "FR"))).toBe("nyc");
    expect(resolveServedCityId(lookup("Tokyo", "JP"))).toBe("nyc");
  });

  it("defaults to New York when the lookup is missing", () => {
    expect(resolveServedCityId(null)).toBe("nyc");
  });
});

describe("isPublicIp", () => {
  it.each([
    [""],
    ["localhost"],
    ["::1"],
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["192.168.0.1"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["fc00::1"],
    ["fe80::1"],
  ])("treats %s as non-public", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([["8.8.8.8"], ["1.2.3.4"], ["172.15.0.1"], ["172.32.0.1"]])("treats %s as public", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });
});

describe("resolveRegion", () => {
  it("falls back to the default city for private IPs", async () => {
    const region = await resolveRegion("127.0.0.1");
    expect(region).toMatchObject({ detected: false, provider: "mock", cityId: "nyc", currency: "USD" });
  });

  it("resolves public IPs through the provider (mock in tests)", async () => {
    const region = await resolveRegion("8.8.8.8");
    expect(region).toMatchObject({
      detected: true,
      provider: "mock",
      ip: "8.8.8.8",
      cityId: "nyc",
      countryCode: "US",
      currency: "USD",
      latitude: 40.7128,
      longitude: -74.006,
    });
  });

  it("caches regions per IP", async () => {
    const first = await resolveRegion("9.9.9.9");
    const second = await resolveRegion("9.9.9.9");
    expect(second).toBe(first);
  });

  it("never throws (total function with fallback)", async () => {
    await expect(resolveRegion("")).resolves.toMatchObject({ detected: false, cityId: "nyc" });
  });
});

describe("geo factory", () => {
  it("defaults to the mock provider", () => {
    expect(geoProviderName()).toBe("mock");
  });
});
