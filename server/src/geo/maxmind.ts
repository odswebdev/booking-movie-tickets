import { open, validate, type CityResponse, type Reader } from "maxmind";
import { env } from "../config/env.js";
import type { GeoLookup, GeoProvider, GeoProviderName } from "./types.js";

export interface MaxmindConfig {
  dbPath?: string;
}

/**
 * Local MaxMind DB (GeoLite2-City.mmdb, user-supplied — the file is too big
 * and too fresh-sensitive to ship). Opened lazily, then kept for the process.
 */
export class MaxmindGeoProvider implements GeoProvider {
  readonly name: GeoProviderName = "maxmind";
  private readonly dbPath: string;
  private reader: Reader<CityResponse> | null = null;

  constructor(config: MaxmindConfig = {}) {
    this.dbPath = config.dbPath ?? env.GEO_MMDB_PATH;
    if (!this.dbPath) {
      throw new Error("GEO_MMDB_PATH must be set for the maxmind geo provider (GeoLite2-City.mmdb)");
    }
  }

  async resolve(ip: string): Promise<GeoLookup | null> {
    if (!validate(ip)) return null;
    if (!this.reader) {
      this.reader = await open<CityResponse>(this.dbPath);
    }
    const result = this.reader.get(ip);
    if (!result) return null;
    return {
      city: result.city?.names?.en ?? null,
      countryCode: result.country?.iso_code ?? null,
      latitude: result.location?.latitude ?? null,
      longitude: result.location?.longitude ?? null,
      // GeoLite2 City has no currency — the served city provides it.
      currency: null,
    };
  }
}
