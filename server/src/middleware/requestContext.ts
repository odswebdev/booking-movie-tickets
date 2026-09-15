import type { NextFunction, Request, Response } from "express";
import { parseUtm, patchRequestContext, runWithRequestContext } from "../utils/requestContext.js";

/**
 * Opens the per-request context (campaign attribution for the audit trail).
 *
 * Sources, in priority order: the `X-Utm` header the SPA sends on every call
 * after it captured the landing URL, then `utm_*` query parameters on the
 * request itself. Both are sanitized by `parseUtm`.
 */
export function attachRequestContext(req: Request, _res: Response, next: NextFunction): void {
  const fromHeader = parseUtm(req.header("x-utm"));
  const fromQuery = parseUtm(req.query);
  runWithRequestContext({ requestId: req.requestId, utm: fromHeader ?? fromQuery, ip: req.ip }, () => {
    patchRequestContext({ requestId: req.requestId });
    next();
  });
}
