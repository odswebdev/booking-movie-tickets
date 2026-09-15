import { getRepositories } from "../db/provider.js";
import type { AuditAction, StoredAuditEvent } from "../db/schema.js";
import { newId } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { requestContext } from "../utils/requestContext.js";

/**
 * Appends an audit event. Never throws (a broken audit trail must not break
 * payments) — but it IS awaited, so tests and exports observe completed writes.
 *
 * Marketing attribution (ТЗ §10) rides along: when the request carried
 * `utm_*` parameters, they are copied into `meta.utm`, so every audit row can
 * be traced back to the campaign that produced it. Campaign names are not PII.
 */
export async function audit(
  action: AuditAction,
  options: {
    userId?: string | null;
    entityId?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const utm = requestContext()?.utm;
  const meta = utm ? { ...(options.meta ?? {}), utm } : (options.meta ?? null);
  const event: StoredAuditEvent = {
    id: newId("audit"),
    at: new Date().toISOString(),
    userId: options.userId ?? null,
    action,
    entityId: options.entityId ?? null,
    meta: meta && Object.keys(meta).length > 0 ? meta : null,
  };
  try {
    await getRepositories().audit.append(event);
  } catch (error) {
    logger.warn({ err: error, action }, "audit append failed");
  }
}
