import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ApiError, ValidationError } from "../utils/errors.js";

type Source = "body" | "params" | "query";

/**
 * Parses a request slice with Zod and replaces it with the parsed value.
 * Every failure becomes a 422 with a stable, field-addressable structure.
 */
export function validate(schema: ZodSchema, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      }));
      return next(new ValidationError(details));
    }
    // Assigning the parsed (and coerced) value keeps downstream handlers typed.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };
}

/** Rejects unknown JSON bodies instead of silently ignoring typos. */
export function requireJsonBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.is("application/json")) return next();
  next(ApiError.badRequest("Content-Type must be application/json"));
}
