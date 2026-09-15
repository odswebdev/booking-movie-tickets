import { env } from "../config/env.js";
import { fetchWithTimeout } from "../services/sms/http.js";
import type { GeoLookup, GeoProvider, GeoProviderName } from "./types.js";

export interface SypexConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

interface SypexResponse {
  city?: { name_en?: unknown; lat?: unknown; lon?: unknown } | null;
  country?: { iso?: unknown } | null;
}

/** Sypex Geo HTTP API (https://sypexgeo.net) — keyless, no currency field. */
export class SypexGeoProvider implements GeoProvider {
  readonly name: GeoProviderName = "sypex";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: SypexConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://api.sypexgeo.net";
    this.timeoutMs = config.timeoutMs ?? env.GEO_TIMEOUT_MS;
  }

  async resolve(ip: string): Promise<GeoLookup | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.baseUrl}/${encodeURIComponent(ip)}/json/`,
        {},
        this.timeoutMs,
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as SypexResponse | null;
    if (!data) return null;
    return {
      city: typeof data.city?.name_en === "string" ? data.city.name_en : null,
      countryCode: typeof data.country?.iso === "string" ? data.country.iso : null,
      latitude: typeof data.city?.lat === "number" ? data.city.lat : null,
      longitude: typeof data.city?.lon === "number" ? data.city.lon : null,
      currency: null,
    };
  }
}
