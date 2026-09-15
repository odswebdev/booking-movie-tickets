import { env } from "../config/env.js";
import { fetchWithTimeout } from "../services/sms/http.js";
import type { GeoLookup, GeoProvider, GeoProviderName } from "./types.js";

export interface IpApiConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

interface IpApiResponse {
  city?: unknown;
  country_code?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  currency?: unknown;
  error?: unknown;
}

/** ipapi.co — keyless JSON API (free tier is rate-limited; failures → null). */
export class IpApiGeoProvider implements GeoProvider {
  readonly name: GeoProviderName = "ipapi";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: IpApiConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://ipapi.co";
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
    const data = (await response.json().catch(() => null)) as IpApiResponse | null;
    if (!data || data.error) return null;
    return {
      city: typeof data.city === "string" ? data.city : null,
      countryCode: typeof data.country_code === "string" ? data.country_code : null,
      latitude: typeof data.latitude === "number" ? data.latitude : null,
      longitude: typeof data.longitude === "number" ? data.longitude : null,
      currency: typeof data.currency === "string" ? data.currency : null,
    };
  }
}
