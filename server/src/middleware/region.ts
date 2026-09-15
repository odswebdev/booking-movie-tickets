import type { NextFunction, Request, Response } from "express";
import { resolveRegion } from "../geo/geoService.js";

/** First entry of X-Forwarded-For, else the socket address. */
export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  const candidate = first?.trim();
  if (candidate) return candidate;
  return req.ip ?? req.socket.remoteAddress ?? "";
}

/**
 * Attaches `req.region` (client IP → geo lookup → served city + currency).
 * Mounted on geo endpoints only (never global — HTTP providers are slow),
 * and never fails the request (`resolveRegion` always falls back).
 *
 * NOTE: deliberately NOT wrapped in `asyncHandler` — that helper is for
 * terminal route handlers and never calls `next()`, which would hang
 * the middleware chain (see item 6 smoke test).
 */
export function attachRegion(req: Request, _res: Response, next: NextFunction): void {
  resolveRegion(clientIp(req)).then(
    (region) => {
      req.region = region;
      next();
    },
    (err: unknown) => {
      next(err);
    },
  );
}
