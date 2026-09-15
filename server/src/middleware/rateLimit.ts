import rateLimit, { type Options } from "express-rate-limit";
import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";

const base: Partial<Options> = {
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // A consistent API error body instead of express-rate-limit's plain text.
  handler: (_req, _res, next) => {
    next(new ApiError(429, "rate_limited", "Too many requests. Please slow down and try again."));
  },
  skip: () => env.isTest,
};

export const globalLimiter = rateLimit({ ...base, limit: env.RATE_LIMIT_MAX });

export const authLimiter = rateLimit({ ...base, limit: env.AUTH_RATE_LIMIT_MAX });

export const paymentLimiter = rateLimit({ ...base, limit: env.PAYMENT_RATE_LIMIT_MAX });
