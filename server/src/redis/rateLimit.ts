/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the RateLimiter interface */
import type { Redis } from "ioredis";
import { logger } from "../utils/logger.js";
import { getRedis } from "./client.js";

/**
 * Fixed-window counter (N events per key per window), e.g. the "5 SMS/hour
 * per phone number" abuse cap. Redis (atomic Lua) when connected, an
 * in-process map otherwise — same decision semantics in both modes.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets (for `retryAfterSeconds` responses). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitDecision>;
}

export interface RateLimiterOptions {
  prefix: string;
  max: number;
  windowSeconds: number;
}

// INCR the counter; on first hit arm the window expiry; report count + TTL.
const CHECK_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly options: RateLimiterOptions,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    try {
      const [count, ttlMs] = (await this.redis.eval(
        CHECK_SCRIPT,
        1,
        `${this.options.prefix}:${key}`,
        String(this.options.windowSeconds * 1000),
      )) as [number, number];
      return {
        allowed: count <= this.options.max,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    } catch (error) {
      // Fail open: a Redis blip must not lock every buyer out of checkout —
      // the per-endpoint express rate limits still guard the API.
      logger.warn({ err: error, prefix: this.options.prefix }, "rate limit check failed; allowing");
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}

class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { count: number; resetMs: number }>();

  constructor(private readonly options: RateLimiterOptions) {}

  async check(key: string): Promise<RateLimitDecision> {
    const nowMs = Date.now();
    if (this.hits.size > 10_000) {
      for (const [entryKey, entry] of this.hits) {
        if (entry.resetMs <= nowMs) this.hits.delete(entryKey);
      }
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetMs <= nowMs) {
      const resetMs = nowMs + this.options.windowSeconds * 1000;
      this.hits.set(key, { count: 1, resetMs });
      return { allowed: 1 <= this.options.max, retryAfterSeconds: this.options.windowSeconds };
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.options.max,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetMs - nowMs) / 1000)),
    };
  }
}

/** Picks the Redis limiter when connected, otherwise the in-memory one. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const redis = getRedis();
  if (redis) return new RedisRateLimiter(redis, options);
  return new MemoryRateLimiter(options);
}
