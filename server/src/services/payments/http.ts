import { ProviderChargeError } from "./types.js";

export interface PspRequestOptions {
  headers?: Record<string, string>;
  /** Network-level retries (safe: every mutating call carries an idempotency key). */
  retries?: number;
  timeoutMs?: number;
  provider: string;
}

/**
 * POST JSON to a PSP with a timeout and one network-only retry.
 * HTTP 4xx/5xx answers are returned to the caller (only transport failures retry).
 * PAN must never reach this layer in loggable form — providers build bodies from
 * in-memory card data and log only status codes.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: PspRequestOptions,
): Promise<{ status: number; data: T }> {
  const { retries = 1, timeoutMs = 10_000, provider } = options;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let data: T;
      try {
        data = (text ? JSON.parse(text) : {}) as T;
      } catch {
        throw ProviderChargeError.gateway(`${provider}: gateway returned a non-JSON response`);
      }
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof ProviderChargeError) throw error;
      lastError = error;
    }
  }
  throw ProviderChargeError.gateway(`${provider}: gateway unreachable`, lastError);
}

export async function getJson<T>(
  url: string,
  options: PspRequestOptions,
): Promise<{ status: number; data: T }> {
  const { timeoutMs = 10_000, provider } = options;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: options.headers ?? {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    try {
      return { status: response.status, data: (text ? JSON.parse(text) : {}) as T };
    } catch {
      throw ProviderChargeError.gateway(`${provider}: gateway returned a non-JSON response`);
    }
  } catch (error) {
    if (error instanceof ProviderChargeError) throw error;
    throw ProviderChargeError.gateway(`${provider}: gateway unreachable`, error);
  }
}

/** Minor units → "123.45" decimal string (YooKassa / PayPal money format). */
export function minorToDecimal(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}
