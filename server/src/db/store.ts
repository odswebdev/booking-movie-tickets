import fs from "node:fs/promises";
import path from "node:path";
import { emptyDb, type DbShape } from "./schema.js";

/**
 * Minimal JSON-file store with atomic writes and a debounced flush queue.
 *
 * It exists so the app runs anywhere with zero infrastructure, while every
 * access still goes through a repository-ish API that can be swapped for
 * Postgres/Prisma without touching the service layer.
 */
export class JsonStore {
  private data: DbShape = emptyDb();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly file: string) {}

  static async open(file: string): Promise<JsonStore> {
    const store = new JsonStore(file);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<DbShape>;
      this.data = { ...emptyDb(), ...parsed };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.data = emptyDb();
      await this.flushNow();
    }
  }

  get db(): DbShape {
    return this.data;
  }

  /** Marks the store dirty; the write is coalesced into a single flush. */
  touch(): void {
    if (this.closed) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow().catch((error) => {
        console.error("[store] flush failed", error);
      });
    }, 50);
    this.flushTimer.unref?.();
  }

  /** Writes immediately and waits (used on shutdown and in tests). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }

  private async flushNow(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const dir = path.dirname(this.file);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
      await fs.rename(tmp, this.file); // atomic on POSIX
    });
    await this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}

let instance: JsonStore | null = null;

export async function initStore(file: string): Promise<JsonStore> {
  instance = await JsonStore.open(file);
  return instance;
}

export function getStore(): JsonStore {
  if (!instance) {
    throw new Error("Store accessed before initStore() — call it during bootstrap");
  }
  return instance;
}

/** Test helper: replaces the singleton without touching the filesystem. */
export function __setStore(store: JsonStore): void {
  instance = store;
}
