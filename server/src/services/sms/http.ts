export interface SmsFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** fetch with a hard timeout (throws on timeout — callers map it to `delivered: false`). */
export async function fetchWithTimeout(
  url: string,
  init: SmsFetchInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
