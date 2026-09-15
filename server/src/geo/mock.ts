/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the GeoProvider interface */
import type { GeoLookup, GeoProvider, GeoProviderName } from "./types.js";

/** Deterministic provider (dev, tests): every IP is downtown New York. */
export class MockGeoProvider implements GeoProvider {
  readonly name: GeoProviderName = "mock";

  async resolve(_ip: string): Promise<GeoLookup> {
    return {
      city: "New York",
      countryCode: "US",
      latitude: 40.7128,
      longitude: -74.006,
      currency: "USD",
    };
  }
}
