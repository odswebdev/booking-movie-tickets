import type { ApiErrorCode, ApiErrorBody } from "@shared/types";
import { authEvents } from "@/lib/authEvents";
import { utmHeaderValue } from "@/lib/analytics";
import { guestHeaders } from "@/lib/guestSession";

const RAW_API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const API_BASE = RAW_API_URL.replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 15_000;

const ACCESS_KEY = "cinetickets:access-token";
const REFRESH_KEY = "cinetickets:refresh-token";

/**
 * Alias header for the access token. Some tunnels / CDNs / preview proxies
 * strip the standard `Authorization` header (and cookies) from requests — the
 * API accepts this header as an equivalent transport. Every authenticated
 * request sends both; the server prefers `Authorization` and falls back here.
 */
export const AUTH_FALLBACK_HEADER = "X-Auth-Token";

/** Access token lives in memory; the long lived refresh token is persisted. */
let accessToken: string | null = null;
/** In-memory mirror so a blocked localStorage does not kill the session. */
let refreshTokenMemory: string | null = null;

export const tokenStore = {
  getAccess(): string | null {
    if (accessToken) return accessToken;
    try {
      accessToken = sessionStorage.getItem(ACCESS_KEY);
    } catch {
      accessToken = null;
    }
    return accessToken;
  },
  setAccess(token: string | null): void {
    accessToken = token;
    try {
      if (token) sessionStorage.setItem(ACCESS_KEY, token);
      else sessionStorage.removeItem(ACCESS_KEY);
    } catch {
      /* private mode: session simply does not survive a reload */
    }
  },
  getRefresh(): string | null {
    try {
      const stored = localStorage.getItem(REFRESH_KEY);
      if (stored) {
        refreshTokenMemory = stored;
        return stored;
      }
      // Another tab may have logged out — a cleared storage wins over memory.
      refreshTokenMemory = null;
      return null;
    } catch {
      // Storage blocked (sandboxed iframe, strict privacy): use memory.
      return refreshTokenMemory;
    }
  },
  setRefresh(token: string | null): void {
    refreshTokenMemory = token;
    try {
      if (token) localStorage.setItem(REFRESH_KEY, token);
      else localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore — the in-memory mirror keeps this tab working */
    }
  },
  clear(): void {
    this.setAccess(null);
    this.setRefresh(null);
  },
};

export class ApiRequestError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details: unknown;
  public readonly requestId?: string;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  get isNetworkError(): boolean {
    return this.code === "internal_error" && this.status === 0;
  }

  /** Field level messages for form binding. */
  get fieldErrors(): Record<string, string> {
    const details = this.details;
    if (!Array.isArray(details)) return {};
    const errors: Record<string, string> = {};
    for (const issue of details) {
      if (issue && typeof issue === "object" && "field" in issue && "message" in issue) {
        const { field, message } = issue as { field: string; message: string };
        if (!errors[field]) errors[field] = message;
      }
    }
    return errors;
  }
}

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiRequestError {
  return error instanceof ApiRequestError && (code === undefined || error.code === code);
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Send the access token (default true) and retry once after a refresh. */
  auth?: boolean;
  /** Extra headers, e.g. the anonymous seat-hold token. */
  headers?: Record<string, string>;
  skipRefresh?: boolean;
}

function resolveUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Public URL builder for EventSource streams (which cannot use the fetch wrapper). */
export function apiStreamUrl(path: string): string {
  return resolveUrl(path);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toError(response: Response, payload: unknown): ApiRequestError {
  const body = payload as ApiErrorBody | null;
  const error = body?.error;
  return new ApiRequestError(
    response.status,
    error?.code ?? "internal_error",
    error?.message ?? `Request failed with status ${response.status}`,
    error?.details,
    error?.requestId,
  );
}

let refreshPromise: Promise<string | null> | null = null;

/** Single-flight refresh so a burst of 401s triggers exactly one call. */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = tokenStore.getRefresh();
    if (!refreshToken) return null;
    try {
      const response = await fetch(resolveUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) throw new Error("refresh failed");
      const data = (await response.json()) as { accessToken: string; refreshToken: string };
      tokenStore.setAccess(data.accessToken);
      tokenStore.setRefresh(data.refreshToken);
      return data.accessToken;
    } catch {
      tokenStore.clear();
      return null;
    } finally {
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();

  return refreshPromise;
}

function withTimeout(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", () => controller.abort(new Error("timeout")), { once: true });
  return {
    signal: controller.signal,
    done: () => {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, auth = true, headers = {}, skipRefresh = false } = options;
  const { signal: abortSignal, done } = withTimeout(signal);

  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    ...guestHeaders(),
    ...headers,
    // Marks fetch/XHR traffic: the API's CSRF guard requires it for
    // cookie-authenticated mutations (cross-site forms cannot set headers).
    "X-Requested-With": "XMLHttpRequest",
  };
  // Campaign attribution (ТЗ §10): the API copies it into `AuditLog.meta`.
  const utm = utmHeaderValue();
  if (utm) requestHeaders["X-Utm"] = utm;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";

  let token = auth ? tokenStore.getAccess() : null;
  if (auth && !token && !skipRefresh && tokenStore.getRefresh()) {
    // The access token lives in memory/sessionStorage and can be gone while the
    // refresh token is still valid (new tab, restored session, storage cleared).
    // Renew it up front instead of sending an unauthenticated request that
    // would 401 and burn a rotation on every single call.
    token = await refreshAccessToken();
  }
  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
    // Duplicate transport: survives proxies that strip `Authorization`.
    requestHeaders[AUTH_FALLBACK_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(resolveUrl(path), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abortSignal,
      // Lets the mirrored session cookie ride along, including cross-origin
      // setups (client and API on different hosts/ports) — the server answers
      // with `Access-Control-Allow-Credentials` and a reflected origin.
      credentials: "include",
    });
  } catch (error) {
    done();
    if ((error as Error)?.name === "TimeoutError") {
      throw new ApiRequestError(
        0,
        "internal_error",
        "The server took too long to respond. Please try again.",
      );
    }
    if ((error as Error)?.name === "AbortError" && signal?.aborted) throw error;
    throw new ApiRequestError(0, "internal_error", "Cannot reach the server. Check your connection.");
  }
  done();

  const payload = await parseBody(response);

  if (response.status === 401 && auth && !skipRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, skipRefresh: true });
    }
    // Refresh failed (rotated away, expired, revoked): the session is gone, so
    // drop the tokens and let the UI send the user back to the login page.
    tokenStore.clear();
    authEvents.emitUnauthorized();
  }

  if (!response.ok) throw toError(response, payload);
  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<ApiRequestOptions, "method" | "body">) =>
    apiFetch<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, "method" | "body">) =>
    apiFetch<T>(path, { ...options, method: "POST", body }),
  del: <T>(path: string, options?: Omit<ApiRequestOptions, "method" | "body">) =>
    apiFetch<T>(path, { ...options, method: "DELETE" }),
};
