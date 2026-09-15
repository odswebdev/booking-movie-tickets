import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-auth-token']",
      "req.headers['x-hold-token']",
      "password",
      "confirmPassword",
      "card.number",
      "card.cvc",
      "otp",
      "refreshToken",
      "accessToken",
    ],
    censor: "[redacted]",
  },
  base: { service: "movie-tickets-api", env: env.NODE_ENV },
  transport:
    env.isProduction || env.isTest ? undefined : { target: "pino/file", options: { destination: 1 } },
});

export type Logger = typeof logger;
