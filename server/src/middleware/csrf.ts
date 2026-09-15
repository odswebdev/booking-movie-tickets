import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for the cookie transport. Header-authenticated requests
 * (`Authorization`, `X-Auth-Token`) are CSRF-proof by construction (a cross-site
 * form cannot set custom headers) — but the mirrored session cookie IS sent
 * cross-site when it runs as SameSite=None (cross-origin HTTPS deploys). For
 * cookie-authenticated mutations we therefore require a custom header, which
 * only real client code (fetch/XHR, subject to CORS preflight) can attach.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction): void {
  if (
    req.auth?.userId &&
    req.auth.via === "cookie" &&
    !SAFE_METHODS.has(req.method) &&
    !req.header("x-requested-with")
  ) {
    next(ApiError.forbidden("Cookie-authenticated mutations must send the X-Requested-With header"));
    return;
  }
  next();
}
