/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the SeatHoldStore interface */
import type { Redis } from "ioredis";
import { getRedis } from "./client.js";

/**
 * Seat hold store (the 5-minute seat lock).
 *
 * Two implementations honour the same contract:
 * - RedisSeatHoldStore — keys with TTL, atomic acquire via Lua;
 * - MemorySeatHoldStore — same semantics for zero-infrastructure mode.
 *
 * Ownership: a hold belongs to a user id (signed in) and/or a guest token.
 * A viewer owns a hold when EITHER matches — so signing in mid-flow never
 * orphans the seats picked as a guest.
 */

export interface HoldOwner {
  ownerToken: string;
  userId: string | null;
}

export interface HoldEntry {
  showtimeId: string;
  seatId: string;
  ownerToken: string;
  userId: string | null;
  expiresAt: string;
}

export type ReplaceResult = { ok: true; expiresAt: string } | { ok: false; taken: string[] };

export interface SeatHoldStore {
  listActive(showtimeId: string): Promise<HoldEntry[]>;
  /**
   * Atomically: release the viewer's previous seats, then take `seatIds`
   * unless any is held by somebody else (`taken` lists those).
   */
  replace(
    showtimeId: string,
    owner: HoldOwner,
    seatIds: string[],
    ttlSeconds: number,
    now?: Date,
  ): Promise<ReplaceResult>;
  release(showtimeId: string, owner: { ownerToken: string | null; userId: string | null }): Promise<void>;
  releaseUser(showtimeId: string, userId: string): Promise<void>;
  /** Drops expired entries (Redis TTLs do this natively; memory needs a sweep). */
  sweep(now?: Date): Promise<void>;
}

function owns(
  entry: { ownerToken: string; userId: string | null },
  viewer: { ownerToken: string | null; userId: string | null },
): boolean {
  if (viewer.userId && entry.userId === viewer.userId) return true;
  return Boolean(viewer.ownerToken && entry.ownerToken === viewer.ownerToken);
}

// ---------------------------------------------------------------------------
// In-memory implementation (zero-infrastructure mode)
// ---------------------------------------------------------------------------

interface MemoryHold extends HoldEntry {
  expiresMs: number;
}

export class MemorySeatHoldStore implements SeatHoldStore {
  private readonly holds = new Map<string, MemoryHold>();

  private key(showtimeId: string, seatId: string): string {
    return `${showtimeId}::${seatId}`;
  }

  async listActive(showtimeId: string): Promise<HoldEntry[]> {
    const nowMs = Date.now();
    const entries: HoldEntry[] = [];
    for (const hold of this.holds.values()) {
      if (hold.showtimeId !== showtimeId || hold.expiresMs <= nowMs) continue;
      entries.push({
        showtimeId: hold.showtimeId,
        seatId: hold.seatId,
        ownerToken: hold.ownerToken,
        userId: hold.userId,
        expiresAt: hold.expiresAt,
      });
    }
    return entries;
  }

  async replace(
    showtimeId: string,
    owner: HoldOwner,
    seatIds: string[],
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<ReplaceResult> {
    const nowMs = now.getTime();
    const unique = [...new Set(seatIds)];
    // Node is single-threaded: check-and-set below is naturally atomic.
    const taken: string[] = [];
    for (const seatId of unique) {
      const current = this.holds.get(this.key(showtimeId, seatId));
      if (current && current.expiresMs > nowMs && !owns(current, owner)) {
        taken.push(seatId);
      }
    }
    if (taken.length > 0) return { ok: false, taken };

    for (const [key, hold] of this.holds) {
      if (hold.showtimeId === showtimeId && owns(hold, owner)) {
        this.holds.delete(key);
      }
    }
    const expiresAt = new Date(nowMs + ttlSeconds * 1000);
    for (const seatId of unique) {
      this.holds.set(this.key(showtimeId, seatId), {
        showtimeId,
        seatId,
        ownerToken: owner.ownerToken,
        userId: owner.userId,
        expiresAt: expiresAt.toISOString(),
        expiresMs: expiresAt.getTime(),
      });
    }
    return { ok: true, expiresAt: expiresAt.toISOString() };
  }

  async release(
    showtimeId: string,
    owner: { ownerToken: string | null; userId: string | null },
  ): Promise<void> {
    if (!owner.ownerToken && !owner.userId) return;
    for (const [key, hold] of this.holds) {
      if (hold.showtimeId === showtimeId && owns(hold, owner)) {
        this.holds.delete(key);
      }
    }
  }

  async releaseUser(showtimeId: string, userId: string): Promise<void> {
    await this.release(showtimeId, { ownerToken: null, userId });
  }

  async sweep(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    for (const [key, hold] of this.holds) {
      if (hold.expiresMs <= nowMs) this.holds.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

const seatKey = (showtimeId: string, seatId: string): string => `seat:${showtimeId}:${seatId}`;
const ownerKey = (showtimeId: string, owner: string): string => `owner:${showtimeId}:${owner}`;
const userOwner = (userId: string): string => `u:${userId}`;
const tokenOwner = (token: string): string => `t:${token}`;

/**
 * Atomic replace. KEYS = [primarySet, secondarySet, seatKey...],
 * ARGV = [myUser, myToken, ttlMs, seatId...].
 *
 * Returns {1} on success or {0, takenJson} when any seat belongs to another
 * viewer. Secondary set exists for the guest→login transition: seats indexed
 * under the old guest token are re-indexed under the user id atomically.
 */
const REPLACE_SCRIPT = `
local primarySet = KEYS[1]
local secondarySet = KEYS[2]
local myUser = ARGV[1]
local myToken = ARGV[2]
local ttlMs = tonumber(ARGV[3])
local lastSeat = #ARGV - 1
local taken = {}
for i = 4, lastSeat do
  local raw = redis.call('GET', KEYS[i - 1])
  if raw then
    local cur = cjson.decode(raw)
    local sameUser = (myUser ~= '' and cur.u == myUser)
    local sameToken = (cur.t == myToken)
    if not (sameUser or sameToken) then
      taken[#taken + 1] = ARGV[i]
    end
  end
end
if #taken > 0 then
  return {0, cjson.encode(taken)}
end
local wanted = {}
for i = 4, lastSeat do
  wanted[ARGV[i]] = true
end
local prefix = 'seat:' .. ARGV[#ARGV]
for _, setKey in ipairs({primarySet, secondarySet}) do
  local old = redis.call('SMEMBERS', setKey)
  for _, seatId in ipairs(old) do
    if not wanted[seatId] then
      local key = prefix .. seatId
      local raw = redis.call('GET', key)
      if raw then
        local cur = cjson.decode(raw)
        local sameUser = (myUser ~= '' and cur.u == myUser)
        local sameToken = (cur.t == myToken)
        if sameUser or sameToken then
          redis.call('DEL', key)
        end
      end
    end
  end
  redis.call('DEL', setKey)
end
local value = cjson.encode({u = myUser, t = myToken})
for i = 4, lastSeat do
  redis.call('SET', KEYS[i - 1], value, 'PX', ttlMs)
  redis.call('SADD', primarySet, ARGV[i])
end
if lastSeat >= 4 then
  redis.call('PEXPIRE', primarySet, ttlMs)
end
return {1}
`;

/** Deletes set members whose seat key is still owned by the viewer. KEYS=[set], ARGV=[myUser, myToken, prefix]. */
const RELEASE_SCRIPT = `
local old = redis.call('SMEMBERS', KEYS[1])
for _, seatId in ipairs(old) do
  local raw = redis.call('GET', ARGV[3] .. seatId)
  if raw then
    local cur = cjson.decode(raw)
    local sameUser = (ARGV[1] ~= '' and cur.u == ARGV[1])
    local sameToken = (ARGV[2] ~= '' and cur.t == ARGV[2])
    if sameUser or sameToken then
      redis.call('DEL', ARGV[3] .. seatId)
    end
  end
end
redis.call('DEL', KEYS[1])
return {1}
`;

export class RedisSeatHoldStore implements SeatHoldStore {
  constructor(private readonly redis: Redis) {}

  private prefix(showtimeId: string): string {
    return `seat:${showtimeId}:`;
  }

  async listActive(showtimeId: string): Promise<HoldEntry[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await this.redis.scan(
        cursor,
        "MATCH",
        `${this.prefix(showtimeId)}*`,
        "COUNT",
        200,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.get(key);
      pipeline.pttl(key);
    }
    const results = await pipeline.exec();
    const entries: HoldEntry[] = [];
    const nowMs = Date.now();
    for (let i = 0; i < keys.length; i += 1) {
      const [getErr, raw] = results?.[i * 2] as [Error | null, string | null];
      const [ttlErr, pttl] = results?.[i * 2 + 1] as [Error | null, number];
      if (getErr || ttlErr || !raw || typeof pttl !== "number" || pttl <= 0) continue;
      try {
        const parsed = JSON.parse(raw) as { u?: string; t?: string };
        const seatId = (keys[i] as string).slice(this.prefix(showtimeId).length);
        entries.push({
          showtimeId,
          seatId,
          ownerToken: parsed.t ?? "",
          userId: parsed.u ? parsed.u : null,
          expiresAt: new Date(nowMs + pttl).toISOString(),
        });
      } catch {
        // Corrupt value — let the TTL reap it.
      }
    }
    return entries;
  }

  async replace(
    showtimeId: string,
    owner: HoldOwner,
    seatIds: string[],
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<ReplaceResult> {
    const unique = [...new Set(seatIds)];
    const primary = owner.userId ? userOwner(owner.userId) : tokenOwner(owner.ownerToken);
    const secondary = owner.userId ? tokenOwner(owner.ownerToken) : primary;
    const keys = [ownerKey(showtimeId, primary), ownerKey(showtimeId, secondary)];
    for (const seatId of unique) keys.push(seatKey(showtimeId, seatId));
    // Last ARGV element carries the key prefix (Lua cannot see showtimeId otherwise).
    const args = [
      owner.userId ?? "",
      owner.ownerToken,
      String(ttlSeconds * 1000),
      ...unique,
      `${showtimeId}:`,
    ];
    const result = (await this.redis.eval(REPLACE_SCRIPT, keys.length, ...keys, ...args)) as [
      number,
      string?,
    ];
    if (result[0] === 1) {
      return { ok: true, expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
    }
    return { ok: false, taken: JSON.parse(result[1] ?? "[]") as string[] };
  }

  async release(
    showtimeId: string,
    owner: { ownerToken: string | null; userId: string | null },
  ): Promise<void> {
    if (!owner.ownerToken && !owner.userId) return;
    const sets: string[] = [];
    if (owner.userId) sets.push(ownerKey(showtimeId, userOwner(owner.userId)));
    if (owner.ownerToken) sets.push(ownerKey(showtimeId, tokenOwner(owner.ownerToken)));
    for (const set of sets) {
      await this.redis.eval(
        RELEASE_SCRIPT,
        1,
        set,
        owner.userId ?? "",
        owner.ownerToken ?? "",
        this.prefix(showtimeId),
      );
    }
  }

  async releaseUser(showtimeId: string, userId: string): Promise<void> {
    await this.release(showtimeId, { ownerToken: null, userId });
  }

  async sweep(): Promise<void> {
    // Redis key TTLs expire holds natively — nothing to sweep.
  }
}

/** Picks the Redis store when connected, otherwise the in-memory one. */
export function createHoldStore(): SeatHoldStore {
  const redis = getRedis();
  if (redis) return new RedisSeatHoldStore(redis);
  return new MemorySeatHoldStore();
}
