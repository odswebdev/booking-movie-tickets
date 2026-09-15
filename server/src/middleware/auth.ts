import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/errors.js";
import { verifyToken } from "../services/authService.js";
import { logger } from "../utils/logger.js";
import { readCookie } from "../utils/http.js";
import { SESSION_COOKIE } from "../config/env.js";

export interface Viewer {
  userId: string | null;
  holdToken: string | null;
}

/** Reads the access token (Bearer header) and the anonymous seat-hold token. */
export const AUTH_FALLBACK_HEADER = "x-auth-token";

export type AuthTransport = "header" | "x-auth-token" | "cookie" | null;

/**
 * Extracts the access token from the request.
 *
 * Some tunnels / CDNs / preview proxies strip the standard `Authorization`
 * header (and cookies) from the request. The web client therefore duplicates
 * the access token into `X-Auth-Token`, which passes such proxies untouched
 * (proven by `X-Hold-Token` arriving intact while `Authorization` was gone).
 * Priority: Authorization → X-Auth-Token → session cookie.
 */
export function extractAccessToken(req: Request): { token: string | null; via: AuthTransport } {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) return { token, via: "header" };
  }
  const fallback = req.header(AUTH_FALLBACK_HEADER);
  if (fallback) {
    const token = fallback.startsWith("Bearer ") ? fallback.slice(7).trim() : fallback.trim();
    if (token) return { token, via: "x-auth-token" };
  }
  // The browser sends the session cookie automatically; native clients (and
  // our own fetch layer) use headers. Either one is enough — storage APIs
  // and custom headers are not always available (iframes, strict privacy
  // settings), the cookie always is.
  const cookieToken = readCookie(req, SESSION_COOKIE);
  if (cookieToken) return { token: cookieToken, via: "cookie" };
  return { token: null, via: null };
}

export function attachViewer(req: Request, _res: Response, next: NextFunction): void {
  const { token, via } = extractAccessToken(req);
  if (token) {
    try {
      const claims = verifyToken(token, "access");
      req.auth = { userId: claims.sub, tokenId: claims.jti, via: via ?? undefined };
    } catch {
      // Anonymous browsing is allowed on public routes; protected routes re-check.
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth?.userId) {
    // Diagnostics only: never log the token itself, just whether it arrived
    // and over which transport (helps to spot proxies stripping headers).
    const header = req.header("authorization");
    logger.warn(
      {
        path: req.originalUrl,
        method: req.method,
        hasAuthHeader: Boolean(header),
        scheme: header ? header.slice(0, 7) : null,
        hasXAuthToken: Boolean(req.header(AUTH_FALLBACK_HEADER)),
        hasCookie: Boolean(readCookie(req, SESSION_COOKIE)),
        origin: req.header("origin") ?? null,
        referer: req.header("referer") ?? null,
        userAgent: req.header("user-agent")?.slice(0, 80) ?? null,
      },
      "protected route called without a valid session",
    );
    return next(ApiError.unauthorized("Please sign in to continue"));
  }
  next();
}

/** Seat holds are owned by the signed-in user, or by a guest token. */
export function viewerFrom(req: Request): Viewer {
  const body = req.body as { holdToken?: string } | undefined;
  return {
    userId: req.auth?.userId ?? null,
    holdToken: req.header("x-hold-token") ?? body?.holdToken ?? null,
  };
}
