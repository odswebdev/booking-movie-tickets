import { ApiRequestError } from "@/api/http";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * API errors carry a stable machine-readable code; the human message is
 * generated client-side so it follows the active language.
 */
export function translateApiError(error: unknown, t: Translate, fallbackKey = "errors.internal"): string {
  if (error instanceof ApiRequestError) {
    return t(`errors.${error.code}`, { defaultValue: error.message });
  }
  if (error instanceof Error && error.message) return error.message;
  return t(fallbackKey);
}
