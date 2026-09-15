import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Redis with a graceful in-memory fallback.
 *
 * When REDIS_URL is unset or unreachable the app keeps working with local
 * implementations (documented per use-site) instead of refusing to boot —
 * zero infrastructure stays a supported mode. The active mode is fixed at
 * startup and logged, so there is no silent split-brain mid-flight.
 */
export type RedisMode = "redis" | "memory";

let client: Redis | null = null;
let subscriber: Redis | null = null;
let mode: RedisMode = "memory";
let initialised = false;

export async function initRedis(): Promise<RedisMode> {
  if (initialised) return mode;
  initialised = true;

  if (!env.REDIS_URL) {
    logger.info("REDIS_URL is not set — using in-memory seat holds and events");
    return mode;
  }

  try {
    const candidate = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      connectTimeout: 5000,
    });
    await candidate.connect();
    await candidate.ping();
    candidate.on("error", (error: Error) => logger.error({ err: error }, "redis connection error"));
    client = candidate;
    mode = "redis";
    logger.info("redis connected — seat holds and events use Redis");
  } catch (error) {
    logger.warn({ err: error }, "redis unreachable — falling back to in-memory seat holds");
    mode = "memory";
  }
  return mode;
}

export function redisMode(): RedisMode {
  return mode;
}

/** Main connection (commands + publishing). Null in memory mode. */
export function getRedis(): Redis | null {
  return mode === "redis" ? client : null;
}

/** Dedicated subscriber connection (a subscribed client cannot issue commands). */
export function getSubscriber(): Redis | null {
  if (mode !== "redis" || !client) return null;
  if (!subscriber) {
    subscriber = client.duplicate();
    subscriber.on("error", (error: Error) => logger.error({ err: error }, "redis subscriber error"));
  }
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  initialised = false;
  mode = "memory";
  const sub = subscriber;
  subscriber = null;
  if (sub) {
    try {
      await sub.quit();
    } catch {
      sub.disconnect();
    }
  }
  const main = client;
  client = null;
  if (main) {
    try {
      await main.quit();
    } catch {
      main.disconnect();
    }
  }
}
