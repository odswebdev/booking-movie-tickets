import type { RegionInfo } from "../../../shared/types.js";

export type { RegionInfo };

export type GeoProviderName = "mock" | "ipapi" | "sypex" | "maxmind";

/** Raw third-party lookup (all nullable — providers differ in coverage). */
export interface GeoLookup {
  city: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  currency: string | null;
}

export interface GeoProvider {
  readonly name: GeoProviderName;
  /** Returns null when the IP can't be placed (private range, unknown). */
  resolve(ip: string): Promise<GeoLookup | null>;
}
