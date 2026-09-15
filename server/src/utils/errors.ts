import type { ApiErrorCode } from "../../../shared/types.js";

/**
 * Application error carrying an HTTP status and a stable machine readable code
 * so the client can branch on `error.code` instead of parsing messages.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly details?: unknown;
  public readonly expose: boolean;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }

  static badRequest(message = "Bad request", details?: unknown): ApiError {
    return new ApiError(400, "bad_request", message, { details });
  }

  static validation(message = "Validation failed", details?: unknown): ApiError {
    return new ApiError(422, "validation_error", message, { details });
  }

  static unauthorized(message = "Authentication required"): ApiError {
    return new ApiError(401, "unauthorized", message);
  }

  static forbidden(message = "You do not have access to this resource"): ApiError {
    return new ApiError(403, "forbidden", message);
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(404, "not_found", message);
  }

  static conflict(message = "Conflict", details?: unknown): ApiError {
    return new ApiError(409, "conflict", message, { details });
  }

  static seatUnavailable(message = "One or more seats are no longer available", details?: unknown) {
    return new ApiError(409, "seat_unavailable", message, { details });
  }

  static holdExpired(message = "Your seat reservation expired. Please pick your seats again.") {
    return new ApiError(409, "hold_expired", message);
  }

  static paymentFailed(message = "Payment could not be completed", details?: unknown) {
    return new ApiError(402, "payment_failed", message, { details });
  }

  static rateLimited(message = "Too many requests", details?: unknown): ApiError {
    return new ApiError(429, "rate_limited", message, { details });
  }
}

export class ValidationError extends ApiError {
  constructor(details: unknown) {
    super(422, "validation_error", "Validation failed", { details });
    this.name = "ValidationError";
  }
}
