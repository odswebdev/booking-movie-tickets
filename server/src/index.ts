import http from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDatabase, dbProvider, initDatabase } from "./db/provider.js";
import { redisMode } from "./redis/client.js";
import { initCatalog } from "./services/catalog.js";
import { configureRates, parseRateOverrides } from "./services/fx.js";
import { configurePromotions } from "./services/promotions.js";
import { seedPromocodes } from "./services/loyaltyService.js";
import { sweepExpired } from "./services/bookingService.js";
import { evaluateAlerts } from "./services/alerts.js";
import { logger } from "./utils/logger.js";

async function bootstrap(): Promise<void> {
  await initDatabase();
  configureRates(parseRateOverrides(env.FX_RATES));
  configurePromotions();
  // Campaigns live in the database (ТЗ §2); the env list is the seed.
  const promos = await seedPromocodes().catch(() => 0);
  logger.info({ promos }, "promo campaigns seeded");
  await initCatalog();

  const app = createApp();
  const server = http.createServer(app);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.listen(env.PORT, env.HOST, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, dataDir: env.DATA_DIR, db: dbProvider(), holds: redisMode() },
      "movie-tickets API listening",
    );
  });

  // Reap expired pending bookings in the background so seats free up even when
  // nobody hits /health/ready (which also sweeps as a safety net).
  const sweepTimer = setInterval(() => {
    void sweepExpired(new Date()).catch((error: unknown) => {
      logger.error({ err: error }, "background sweep failed");
    });
  }, 60_000);
  sweepTimer.unref();

  // Threshold alerts over the metric registry (latency, 401-rate,
  // payment_failed, PSP circuit, queues) — ТЗ §1.7.
  const alertTimer = setInterval(() => {
    void evaluateAlerts().catch((error: unknown) => {
      logger.warn({ err: error }, "alert evaluation failed");
    });
  }, env.ALERT_EVAL_INTERVAL_MS);
  alertTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    clearInterval(sweepTimer);
    clearInterval(alertTimer);
    server.close((error) => {
      if (error) logger.error({ err: error }, "error closing HTTP server");
    });

    // Force exit if in-flight requests refuse to drain.
    const forceExit = setTimeout(() => {
      logger.warn("forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await closeDatabase();
      logger.info("datastore flushed");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception — exiting");
    process.exit(1);
  });
}

void bootstrap().catch((error) => {
  logger.fatal({ err: error }, "failed to start server");
  process.exit(1);
});
