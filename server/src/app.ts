import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { attachViewer } from "./middleware/auth.js";
import { attachRequestContext } from "./middleware/requestContext.js";
import { csrfGuard } from "./middleware/csrf.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { httpMetrics } from "./middleware/metrics.js";
import { metricsRouter } from "./modules/metrics.js";
import { authRouter } from "./modules/auth.js";
import { moviesRouter } from "./modules/movies.js";
import { showtimesRouter } from "./modules/showtimes.js";
import { bookingsRouter } from "./modules/bookings.js";
import { paymentsRouter } from "./modules/payments.js";
import { webhooksRouter } from "./modules/webhooks.js";
import { configRouter } from "./modules/config.js";
import { notifyRefundIssued, notifyTicketReady } from "./queues/notifications.js";
import { onBookingConfirmed, onBookingRefunded } from "./services/bookingService.js";
import { geoRouter } from "./modules/geo.js";
import { promotionsRouter } from "./modules/promotions.js";
import { healthRouter } from "./modules/health.js";
import { seoRouter, serveShell } from "./modules/seo.js";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https://image.tmdb.org",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function createApp(): Express {
  const app = express();

  // Ticket emails (sync verify + async webhook confirmations both land here).
  onBookingConfirmed(notifyTicketReady);
  onBookingRefunded(notifyRefundIssued);

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      autoLogging: {
        ignore: (req: { url?: string }) => req.url === "/api/health" || req.url === "/api/health/ready",
      },
    }),
  );

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.requestId = (req as unknown as { id?: string }).id ?? randomUUID();
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: env.isProduction ? { directives: {} } : false,
      crossOriginEmbedderPolicy: false,
      hsts: env.isProduction,
    }),
  );

  // Applied manually below so the SPA keeps its own strict policy.
  if (env.isProduction) {
    app.use((_req, res, next) => {
      res.setHeader("Content-Security-Policy", CSP);
      next();
    });
  }

  app.use(
    cors({
      // `true` reflects the request origin (required for credentialed
      // requests — `*` is rejected by browsers when credentials are on).
      // Production deployments should set an explicit CORS_ORIGIN allow-list.
      origin: env.corsOrigins.includes("*")
        ? true
        : env.corsOrigins.length === 1
          ? env.corsOrigins[0]
          : env.corsOrigins,
      // Auth primarily uses headers, but the mirrored session cookie also
      // rides along when the browser has it (same-origin deploys, localhost).
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Auth-Token",
        "X-Hold-Token",
        "X-Request-Id",
        "X-Requested-With",
        "X-Utm",
      ],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );

  // `verify` stashes the raw bytes for payment-webhook signature checks
  // (Stripe HMAC is computed over the exact raw body, not re-serialized JSON).
  app.use(
    express.json({
      limit: "64kb",
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(globalLimiter);
  app.use(httpMetrics);
  // Before the routers: every audit row written downstream inherits the
  // campaign attribution of this request.
  app.use(attachRequestContext);
  app.use(attachViewer);
  app.use(csrfGuard);

  app.use((req, res, next) => {
    if (req.requestId) res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  // Machine-readable SEO files live at the site root (ТЗ §8).
  app.use(seoRouter);

  app.use("/api/config", configRouter);
  // Prometheus scrape target + alert/JSON views (ТЗ §1.7).
  app.use("/api/metrics", metricsRouter);
  app.use("/api/promotions", promotionsRouter);
  app.use("/api", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/movies", moviesRouter);
  app.use("/api", geoRouter);
  app.use("/api/showtimes", showtimesRouter);
  app.use("/api/bookings", bookingsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/webhooks", webhooksRouter);

  // API 404s are always JSON, never the SPA shell.
  app.use("/api", notFoundHandler);

  if (env.SERVE_CLIENT && fs.existsSync(env.clientDist)) {
    app.use(
      express.static(env.clientDist, {
        index: false,
        // Hashed asset filenames are immutable; index.html must never be cached.
        maxAge: env.isProduction ? "1h" : 0,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else if (path.basename(filePath) === "index.html") {
            res.setHeader("Cache-Control", "no-store");
          }
        },
      }),
    );
    // Prerendered storefront: the shell is served with per-route title,
    // description, canonical, hreflang, OG tags and JSON-LD (ТЗ §8), so
    // crawlers that do not run JS still see the catalog.
    app.get("*", (req, res, next) => {
      void serveShell(req, res, next);
    });
  } else if (env.SERVE_CLIENT) {
    app.get("*", (_req, res) => {
      res
        .status(503)
        .type("html")
        .send(
          "<h1>Client build not found</h1><p>Run <code>npm run build -w @movie-tickets/client</code> or disable SERVE_CLIENT.</p>",
        );
    });
  }

  app.use(errorHandler);

  return app;
}
