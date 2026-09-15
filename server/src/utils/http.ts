import type { Request } from "express";
import { ApiError } from "./errors.js";

/**
 * Express types route params as possibly-undefined under
 * `noUncheckedIndexedAccess`; this keeps routes honest without `as string` casts.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw ApiError.badRequest(`Missing route parameter: ${name}`);
  }
  return value;
}

/** Reads a single cookie from the raw header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}
