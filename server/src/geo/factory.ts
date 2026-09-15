import { env } from "../config/env.js";
import { IpApiGeoProvider } from "./ipapi.js";
import { MaxmindGeoProvider } from "./maxmind.js";
import { MockGeoProvider } from "./mock.js";
import { SypexGeoProvider } from "./sypex.js";
import type { GeoProvider, GeoProviderName } from "./types.js";

/**
 * Resolves the geo backend.
 *
 * - Explicit `GEO_PROVIDER` always wins.
 * - Otherwise a `GEO_MMDB_PATH` selects the local MaxMind DB.
 * - Otherwise `mock` (deterministic New York — dev, tests).
 */
const instances = new Map<GeoProviderName, GeoProvider>();

export function geoProviderName(): GeoProviderName {
  if (env.GEO_PROVIDER) return env.GEO_PROVIDER;
  return env.GEO_MMDB_PATH ? "maxmind" : "mock";
}

export function geoProvider(): GeoProvider {
  const name = geoProviderName();
  const existing = instances.get(name);
  if (existing) return existing;
  let provider: GeoProvider;
  switch (name) {
    case "ipapi":
      provider = new IpApiGeoProvider();
      break;
    case "sypex":
      provider = new SypexGeoProvider();
      break;
    case "maxmind":
      provider = new MaxmindGeoProvider();
      break;
    case "mock":
    default:
      provider = new MockGeoProvider();
      break;
  }
  instances.set(name, provider);
  return provider;
}

/** Test helper: drops cached instances so constructor errors can be re-triggered. */
export function __resetGeoProviders(): void {
  instances.clear();
}
