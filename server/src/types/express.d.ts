import type { User } from "../../../shared/types.js";
import type { RegionInfo } from "../geo/types.js";

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, echoed in responses and error bodies. */
      requestId?: string;
      /** Present when a valid access token was supplied. */
      auth?: { userId: string; tokenId?: string; via?: "header" | "x-auth-token" | "cookie" };
      /** IP-geo region, attached by `attachRegion` on geo endpoints. */
      region?: RegionInfo;
      /** Raw request bytes (payment webhook signature verification). */
      rawBody?: Buffer;
      /** Attached by pino-http. */
      log?: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
      };
      user?: User;
    }
  }
}

export {};
