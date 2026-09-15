import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

export interface TestContext {
  app: Express;
  tempDir: string;
}

/**
 * Shared test bootstrap. Environment is configured before any app module is
 * imported (dynamic imports only), because `env` is parsed at import time.
 *
 * `DATABASE_URL` / `REDIS_URL` are intentionally left untouched:
 * unset → JSON + in-memory mode (`npm test`), set → Postgres + Redis
 * (`npm run test:pg`). In Postgres mode every file starts from a wiped
 * database, because all files share the same `cinetickets_test` database
 * while using overlapping fixture emails.
 */
export async function setupTestApp(
  tmpPrefix: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-value-that-is-long-enough";
  process.env.DATA_DIR = tempDir;
  process.env.SERVE_CLIENT = "false";
  process.env.LOG_LEVEL = "silent";
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const { initDatabase, dbProvider } = await import("../src/db/provider.js");
  await initDatabase();
  if (dbProvider() === "postgres") {
    await resetPostgres();
  }
  const { configurePromotions } = await import("../src/services/promotions.js");
  configurePromotions();
  const { seedPromocodes } = await import("../src/services/loyaltyService.js");
  await seedPromocodes().catch(() => 0);
  const { initCatalog } = await import("../src/services/catalog.js");
  await initCatalog();
  const { createApp } = await import("../src/app.js");
  return { app: createApp(), tempDir };
}

/** TRUNCATEs every transactional table and clears seat-hold keys. */
async function resetPostgres(): Promise<void> {
  const { getPrisma } = await import("../src/db/prisma/client.js");
  await getPrisma().$executeRawUnsafe(
    `TRUNCATE TABLE "reviews", "referrals", "bonus_transactions", "promocodes", "refunds", "tickets",
       "webhook_events", "payments", "bookings", "sessions", "users",
       "screenings", "seats", "halls", "cinemas", "cities", "movies"
     RESTART IDENTITY CASCADE`,
  );
  const { getRedis, redisMode } = await import("../src/redis/client.js");
  if (redisMode() === "redis") {
    const redis = getRedis();
    if (!redis) return;
    for (const pattern of ["seat:*", "owner:*", "sms:rl:*"]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  }
}

export async function teardownTestApp(tempDir: string): Promise<void> {
  const { closeDatabase } = await import("../src/db/provider.js");
  await closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
