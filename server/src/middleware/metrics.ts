import type { NextFunction, Request, Response } from "express";
import { recordHttpRequest } from "../utils/metrics.js";

/**
 * Latency + error-rate instrumentation for every request.
 *
 * Labels use the *route template* (`/api/bookings/:bookingId`) rather than the
 * concrete URL, otherwise every booking id would create its own time series
 * and blow up the registry.
 */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = routeTemplate(req);
    try {
      recordHttpRequest({
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 1000) / 1000,
      });
    } catch {
      // Metrics must never break a response.
    }
  });

  next();
}

/** Prefers the matched Express route path, falls back to the top-level API area. */
export function routeTemplate(req: Request): string {
  const routePath = (req.route as { path?: string } | undefined)?.path;
  const base = req.baseUrl ?? "";
  if (routePath) return `${base}${routePath === "/" ? "" : routePath}` || "/";
  // Requests rejected before routing (auth guards, CSRF) and 404s land here:
  // derive a bounded template from the URL, collapsing opaque ids so every
  // booking id does not become its own time series.
  const path = (req.originalUrl ?? req.url ?? "/").split("?")[0] ?? "/";
  const segments = path
    .split("/")
    .filter(Boolean)
    .slice(0, 4)
    .map((segment) => (/^(\d+|[0-9a-f]{8,}|[a-z]{2,4}_[A-Za-z0-9_-]{6,})$/.test(segment) ? ":id" : segment));
  return segments.length > 0 ? `/${segments.join("/")}` : base || "/";
}
