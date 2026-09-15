import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import type { ApiErrorBody } from "../../../shared/types.js";
import { env } from "../config/env.js";
import { ApiError, ValidationError } from "../utils/errors.js";

export function notFoundHandler(_req: Request, res: Response): void {
  const body: ApiErrorBody = {
    error: { code: "not_found", message: "Endpoint not found", requestId: _req.requestId },
  };
  res.status(404).json(body);
}

/**
 * Single place where every error becomes a response. Internal details are
 * logged with the request id but never exposed to the client.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
      code: issue.code,
    }));
    return void res.status(422).json({
      error: { code: "validation_error", message: "Validation failed", details, requestId },
    } satisfies ApiErrorBody);
  }

  if (err instanceof ValidationError || err instanceof ApiError) {
    return void res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    } satisfies ApiErrorBody);
  }

  const status =
    typeof (err as { status?: number })?.status === "number" ? (err as { status: number }).status : 500;
  const isClientError = status >= 400 && status < 500;

  if (!isClientError) {
    req.log?.error({ err, requestId }, "Unhandled error");
  }

  const body: ApiErrorBody = {
    error: {
      code: isClientError ? "bad_request" : "internal_error",
      message: isClientError
        ? (err as Error).message || "Bad request"
        : "Something went wrong on our side. Please try again.",
      requestId,
    },
  };
  if (env.NODE_ENV !== "production" && err instanceof Error) {
    body.error.details = { stack: err.stack };
  }
  res.status(isClientError ? status : 500).json(body);
}
