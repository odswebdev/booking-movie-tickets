import path from "node:path";
import { env } from "../config/env.js";
import { closeRedis, initRedis, type RedisMode } from "../redis/client.js";
import { createSeatEventBus, type SeatEventBus } from "../redis/events.js";
import { createHoldStore, type SeatHoldStore } from "../redis/holds.js";
import { disconnectPrisma, getPrisma } from "./prisma/client.js";
import { createPrismaRepositories } from "./prisma/repositories.js";
import { createJsonRepositories } from "./json/repositories.js";
import { getStore, initStore } from "./store.js";
import type { Repositories } from "./repositories.js";
import { logger } from "../utils/logger.js";

/**
 * Datastore wiring. Selected once at startup:
 * - DATABASE_URL set → Prisma/PostgreSQL, otherwise the JSON file;
 * - REDIS_URL reachable → Redis holds + pub/sub, otherwise in-memory.
 */
export type DbMode = "json" | "postgres";

let repositories: Repositories | null = null;
let holdStore: SeatHoldStore | null = null;
let seatBus: SeatEventBus | null = null;
let dbMode: DbMode = "json";

export async function initDatabase(): Promise<{ db: DbMode; holds: RedisMode }> {
  if (env.DATABASE_URL) {
    repositories = createPrismaRepositories();
    // Fail fast: a configured-but-unreachable database must not boot half-alive.
    await getPrisma().$connect();
    dbMode = "postgres";
    logger.info("database mode: postgres (prisma)");
  } else {
    await initStore(path.join(env.DATA_DIR, "db.json"));
    repositories = createJsonRepositories();
    dbMode = "json";
    logger.info("database mode: json file");
  }

  const holds = await initRedis();
  holdStore = createHoldStore();
  seatBus = createSeatEventBus();
  return { db: dbMode, holds };
}

export function dbProvider(): DbMode {
  return dbMode;
}

export function getRepositories(): Repositories {
  if (!repositories) throw new Error("Database accessed before initDatabase() — call it during bootstrap");
  return repositories;
}

export function getHoldStore(): SeatHoldStore {
  if (!holdStore) throw new Error("Hold store accessed before initDatabase() — call it during bootstrap");
  return holdStore;
}

export function getSeatBus(): SeatEventBus {
  if (!seatBus) throw new Error("Seat bus accessed before initDatabase() — call it during bootstrap");
  return seatBus;
}

export async function closeDatabase(): Promise<void> {
  repositories = null;
  holdStore = null;
  seatBus = null;
  if (dbMode === "json") {
    try {
      await getStore().close();
    } catch {
      // initDatabase() never ran — nothing to flush.
    }
  }
  await closeRedis();
  await disconnectPrisma();
}
