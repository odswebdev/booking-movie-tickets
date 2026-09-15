/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the SeatEventBus interface */
import { EventEmitter } from "node:events";
import { logger } from "../utils/logger.js";
import { getRedis, getSubscriber } from "./client.js";

/**
 * Seat-change fan-out feeding the SSE stream.
 * Redis pub/sub in Redis mode (works across instances), an in-process
 * emitter otherwise. Payloads carry no seat data — clients re-fetch the
 * seat map with their own viewer, so per-user masking stays intact.
 */
export interface SeatEventBus {
  publish(showtimeId: string): Promise<void>;
  subscribe(showtimeId: string, listener: () => void): () => void;
}

const channel = (showtimeId: string): string => `seats:${showtimeId}`;

class MemorySeatEventBus implements SeatEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  async publish(showtimeId: string): Promise<void> {
    this.emitter.emit(channel(showtimeId));
  }

  subscribe(showtimeId: string, listener: () => void): () => void {
    const name = channel(showtimeId);
    this.emitter.on(name, listener);
    return () => {
      this.emitter.off(name, listener);
    };
  }
}

class RedisSeatEventBus implements SeatEventBus {
  private readonly listeners = new Map<string, Set<() => void>>();
  private listening = false;

  async publish(showtimeId: string): Promise<void> {
    try {
      await getRedis()?.publish(channel(showtimeId), String(Date.now()));
    } catch (error) {
      // Seat events are best-effort: the client also polls as a fallback.
      logger.warn({ err: error }, "seat event publish failed");
    }
  }

  subscribe(showtimeId: string, listener: () => void): () => void {
    const name = channel(showtimeId);
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
      void this.ensureSubscribed(name);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(name);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(name);
        void getSubscriber()
          ?.unsubscribe(name)
          .catch(() => undefined);
      }
    };
  }

  private async ensureSubscribed(name: string): Promise<void> {
    const sub = getSubscriber();
    if (!sub) return;
    if (!this.listening) {
      this.listening = true;
      sub.on("message", (received: string) => {
        for (const listener of this.listeners.get(received) ?? []) {
          try {
            listener();
          } catch {
            // A broken SSE sink must not break the bus.
          }
        }
      });
    }
    try {
      await sub.subscribe(name);
    } catch (error) {
      logger.warn({ err: error }, "seat event subscribe failed");
    }
  }
}

export function createSeatEventBus(): SeatEventBus {
  return getRedis() ? new RedisSeatEventBus() : new MemorySeatEventBus();
}
