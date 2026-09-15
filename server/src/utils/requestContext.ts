import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context for things that must travel with an async call chain but
 * are not worth threading through every service signature (ТЗ §10: кампании
 * из UTM должны попадать в `AuditLog.meta`, а не теряться по пути).
 *
 * The store is only ever populated from sanitized, bounded request metadata —
 * never PII, never tokens.
 */
export interface RequestContext {
  requestId?: string;
  /** Campaign attribution captured from `utm_*` / `X-Utm`. */
  utm?: Record<string, string>;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function patchRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export const UTM_MAX_VALUE = 64;

/**
 * Accepts `utm_source=google&utm_medium=cpc`, the same string in a header, or
 * a JSON object. Anything unknown/oversized is dropped so the audit trail can
 * never be used as a payload dump.
 */
export function parseUtm(input: unknown): Record<string, string> | undefined {
  if (input === null || input === undefined) return undefined;

  let raw: Record<string, unknown>;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        raw = parsed as Record<string, unknown>;
      } catch {
        return undefined;
      }
    } else {
      raw = Object.fromEntries(new URLSearchParams(trimmed));
    }
  } else if (typeof input === "object") {
    raw = input as Record<string, unknown>;
  } else {
    return undefined;
  }

  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    const clean = value.trim().slice(0, UTM_MAX_VALUE);
    if (clean) utm[key] = clean;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}
