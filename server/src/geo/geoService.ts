import { mustCityById, resolveServedCityId } from "./cities.js";
import { geoProvider, geoProviderName } from "./factory.js";
import type { GeoLookup, RegionInfo } from "./types.js";

/** 5-minute per-IP cache (HTTP providers are rate-limited and slow). */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 5_000;
const cache = new Map<string, { region: RegionInfo; expiresAt: number }>();

/** Test helper: clears the region cache. */
export function __clearRegionCache(): void {
  cache.clear();
}

/** Private/loopback/link-local ranges are never sent to geo providers. */
export function isPublicIp(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  if (!value || value === "localhost" || value === "::1" || value === "::ffff:127.0.0.1") return false;
  if (value.startsWith("127.") || value.startsWith("10.") || value.startsWith("192.168.")) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return false;
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return false;
  return true;
}

/**
 * Maps a client IP onto a served city. Total function: provider failures,
 * private IPs and unknown cities all fall back to the default city with
 * `detected: false` — geo never fails a request.
 */
export async function resolveRegion(ip: string): Promise<RegionInfo> {
  const clean = ip.trim();
  const cached = cache.get(clean);
  if (cached && cached.expiresAt > Date.now()) return cached.region;

  const name = geoProviderName();
  let lookup: GeoLookup | null = null;
  if (isPublicIp(clean)) {
    try {
      lookup = await geoProvider().resolve(clean);
    } catch {
      lookup = null;
    }
  }
  const city = mustCityById(resolveServedCityId(lookup));
  const region: RegionInfo = {
    detected: lookup !== null,
    provider: name,
    ip: clean,
    cityId: city.id,
    countryCode: lookup?.countryCode ?? city.countryCode,
    currency: lookup?.currency ?? city.currency,
    latitude: lookup?.latitude ?? city.center.lat,
    longitude: lookup?.longitude ?? city.center.lng,
  };
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(clean, { region, expiresAt: Date.now() + CACHE_TTL_MS });
  return region;
}
