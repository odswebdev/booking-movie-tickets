import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import {
  alertsFired,
  circuitBreakerState,
  httpDuration,
  metrics,
  paymentsInFlight,
  quantileOfSeries,
  type HistogramSeries,
} from "../utils/metrics.js";

/**
 * Threshold-based alerting (ТЗ §1.7: «метрики (latency, 401-rate,
 * payment_failed) и алерты»).
 *
 * The evaluator diffs the cumulative metric registry between two runs, so the
 * window is exactly the evaluation interval (Prometheus `rate()` semantics).
 * Every firing rule is: structured log → optional ALERT_WEBHOOK_URL POST →
 * ring buffer for `GET /api/metrics/alerts`. Rules carry a cooldown so a
 * sustained incident does not spam the channel every 30 seconds.
 */

export type AlertSeverity = "warning" | "critical";

export interface Alert {
  rule: string;
  severity: AlertSeverity;
  summary: string;
  /** Metric values behind the decision — no PII, safe to forward. */
  details: Record<string, number | string>;
  firedAt: string;
}

interface CounterDelta {
  key: string;
  labels: Record<string, string>;
  value: number;
}

interface RuleContext {
  /** Counter deltas since the previous evaluation. */
  counters: CounterDelta[];
  /** Latency histogram deltas since the previous evaluation. */
  latency: { count: number; sumMs: number; p95Ms: number };
  intervalSeconds: number;
  now: number;
}

interface Rule {
  id: string;
  severity: AlertSeverity;
  cooldownMs: number;
  evaluate(context: RuleContext): Omit<Alert, "firedAt"> | null;
}

function sumOf(
  counters: CounterDelta[],
  metric: string,
  predicate: (labels: Record<string, string>) => boolean = () => true,
): number {
  return counters
    .filter((entry) => entry.key.startsWith(metric) && predicate(entry.labels))
    .reduce((sum, entry) => sum + entry.value, 0);
}

const rules: Rule[] = [
  {
    id: "payment_failure_rate",
    severity: "critical",
    cooldownMs: 5 * 60_000,
    evaluate({ counters }) {
      const succeeded = sumOf(counters, "payment_outcomes_total", (labels) => labels.outcome === "succeeded");
      const failed = sumOf(counters, "payment_outcomes_total", (labels) => labels.outcome === "failed");
      const total = succeeded + failed;
      if (total < env.ALERT_MIN_PAYMENT_SAMPLES) return null;
      const rate = failed / total;
      if (rate < env.ALERT_PAYMENT_FAILURE_RATE) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `Payment failure rate ${(rate * 100).toFixed(1)}% over the last window`,
        details: { succeeded, failed, total, rate: Number(rate.toFixed(4)) },
      };
    },
  },
  {
    id: "http_error_rate",
    severity: "warning",
    cooldownMs: 5 * 60_000,
    evaluate({ counters }) {
      let total = 0;
      let serverErrors = 0;
      for (const entry of counters) {
        if (!entry.key.startsWith("http_requests_total")) continue;
        const status = Number(entry.labels.status ?? 0);
        total += entry.value;
        if (status >= 500) serverErrors += entry.value;
      }
      if (total < env.ALERT_MIN_HTTP_SAMPLES) return null;
      const rate = serverErrors / total;
      if (rate < env.ALERT_HTTP_ERROR_RATE) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `HTTP 5xx rate ${(rate * 100).toFixed(1)}% over the last window`,
        details: { total, serverErrors, rate: Number(rate.toFixed(4)) },
      };
    },
  },
  {
    id: "auth_401_rate",
    severity: "warning",
    cooldownMs: 5 * 60_000,
    evaluate({ counters, intervalSeconds }) {
      const unauthorized = sumOf(counters, "http_unauthorized_total");
      if (unauthorized === 0) return null;
      const perMinute = unauthorized / (intervalSeconds / 60);
      if (perMinute < env.ALERT_AUTH_401_PER_MINUTE) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `Unauthorized responses at ${perMinute.toFixed(1)}/min — expired tokens or credential stuffing`,
        details: { unauthorized, perMinute: Number(perMinute.toFixed(2)) },
      };
    },
  },
  {
    id: "http_latency_p95",
    severity: "warning",
    cooldownMs: 5 * 60_000,
    evaluate({ latency }) {
      if (latency.count < env.ALERT_MIN_HTTP_SAMPLES) return null;
      if (latency.p95Ms < env.ALERT_LATENCY_P95_MS) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `Request p95 latency ${latency.p95Ms.toFixed(0)}ms (budget ${env.ALERT_LATENCY_P95_MS}ms)`,
        details: { p95Ms: latency.p95Ms, requests: latency.count },
      };
    },
  },
  {
    id: "seat_conflict_storm",
    severity: "warning",
    cooldownMs: 3 * 60_000,
    evaluate({ counters, intervalSeconds }) {
      const conflicts = sumOf(counters, "seat_conflicts_total");
      const perMinute = conflicts / (intervalSeconds / 60);
      if (perMinute < env.ALERT_SEAT_CONFLICTS_PER_MINUTE) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `Seat contention at ${perMinute.toFixed(1)} conflicts/min`,
        details: { conflicts, perMinute: Number(perMinute.toFixed(2)) },
      };
    },
  },
  {
    id: "sms_quota_pressure",
    severity: "warning",
    cooldownMs: 10 * 60_000,
    evaluate({ counters }) {
      const refused = sumOf(counters, "sms_quota_hits_total");
      if (refused < env.ALERT_SMS_QUOTA_HITS) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `${refused} SMS codes refused by the hourly quota — possible abuse`,
        details: { refused },
      };
    },
  },
  {
    id: "payment_provider_unavailable",
    severity: "critical",
    cooldownMs: 3 * 60_000,
    evaluate() {
      const open = circuitBreakerState.all().filter((entry) => entry.value >= 1);
      if (open.length === 0) return null;
      const providers = open.map((entry) => entry.labels.provider ?? "unknown").join(", ");
      return {
        rule: this.id,
        severity: this.severity,
        summary: `PSP circuit breaker open for: ${providers}`,
        details: { providers, openCircuits: open.length },
      };
    },
  },
  {
    id: "notification_failures",
    severity: "warning",
    cooldownMs: 10 * 60_000,
    evaluate({ counters }) {
      const failures = sumOf(counters, "notification_failures_total");
      if (failures < env.ALERT_NOTIFICATION_FAILURES) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `${failures} ticket/refund notification failures in the last window`,
        details: { failures },
      };
    },
  },
  {
    id: "queue_job_failures",
    severity: "warning",
    cooldownMs: 10 * 60_000,
    evaluate({ counters }) {
      const failed = sumOf(counters, "queue_jobs_total", (labels) => labels.result === "failed");
      if (failed < env.ALERT_QUEUE_FAILURES) return null;
      return {
        rule: this.id,
        severity: this.severity,
        summary: `${failed} background jobs failed (SMS/email/PDF)`,
        details: { failed },
      };
    },
  },
];

/** Ring buffer of the most recent alerts (exposed by the metrics API). */
const recent: Alert[] = [];
const MAX_RECENT_ALERTS = 100;
const lastFiredAt = new Map<string, number>();

let lastEvaluation: { at: number; counters: Map<string, number>; latency: HistogramSnapshot } | null = null;

interface HistogramSnapshot {
  count: number;
  sum: number;
  series: Map<string, HistogramSeries>;
}

/** Flattens every counter series into `name|labels → value` pairs. */
function snapshotCounters(): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const name of metrics.counterNames()) {
    const counter = metrics.counterByName(name);
    if (!counter) continue;
    for (const entry of counter.all()) {
      snapshot.set(`${name}|${JSON.stringify(entry.labels)}`, entry.value);
    }
  }
  return snapshot;
}

function snapshotLatency(): HistogramSnapshot {
  return { count: 0, sum: 0, series: httpDuration.snapshot() };
}

function counterDeltas(previous: Map<string, number> | null, current: Map<string, number>): CounterDelta[] {
  const deltas: CounterDelta[] = [];
  for (const [key, value] of current) {
    const before = previous?.get(key) ?? 0;
    const delta = value - before;
    if (delta <= 0) continue;
    const [metric, labelsJson] = key.split("|");
    deltas.push({
      key: metric ?? key,
      labels: labelsJson ? (JSON.parse(labelsJson) as Record<string, string>) : {},
      value: delta,
    });
  }
  return deltas;
}

function latencyDelta(
  previous: HistogramSnapshot | null,
  current: HistogramSnapshot,
): RuleContext["latency"] {
  const buckets = httpDuration.bounds;
  let count = 0;
  let sumMs = 0;
  let p95Ms = 0;

  for (const [key, series] of current.series) {
    const before = previous?.series.get(key);
    const counts = series.counts.map((value, index) => value - (before?.counts[index] ?? 0));
    const total = series.count - (before?.count ?? 0);
    const sum = series.sum - (before?.sum ?? 0);
    count += total;
    sumMs += sum;
    const merged: HistogramSeries = {
      labels: series.labels,
      counts,
      sum,
      count: total,
    };
    p95Ms = Math.max(p95Ms, quantileOfSeries(buckets, merged, 0.95));
  }

  return { count, sumMs, p95Ms };
}

/**
 * Runs every rule, delivers the alert and updates the watermarks.
 * Never throws — alerting must not break the request path.
 */
export async function evaluateAlerts(now: number = Date.now()): Promise<Alert[]> {
  if (!env.ALERTS_ENABLED) return [];
  try {
    const counters = snapshotCounters();
    const latencySnapshot = snapshotLatency();
    const intervalSeconds = lastEvaluation
      ? Math.max(1, (now - lastEvaluation.at) / 1000)
      : env.ALERT_EVAL_INTERVAL_MS / 1000;

    const context: RuleContext = {
      counters: counterDeltas(lastEvaluation?.counters ?? null, counters),
      latency: latencyDelta(lastEvaluation?.latency ?? null, latencySnapshot),
      intervalSeconds,
      now,
    };

    lastEvaluation = { at: now, counters, latency: latencySnapshot };

    const fired: Alert[] = [];
    for (const rule of rules) {
      const lastAt = lastFiredAt.get(rule.id) ?? 0;
      if (now - lastAt < rule.cooldownMs) continue;
      const decision = rule.evaluate(context);
      if (!decision) continue;
      const alert: Alert = { ...decision, firedAt: new Date(now).toISOString() };
      lastFiredAt.set(rule.id, now);
      recent.unshift(alert);
      if (recent.length > MAX_RECENT_ALERTS) recent.length = MAX_RECENT_ALERTS;
      alertsFired.inc({ rule: rule.id, severity: rule.severity });
      fired.push(alert);
      await deliver(alert);
    }
    return fired;
  } catch (error) {
    logger.warn({ err: error }, "alert evaluation failed");
    return [];
  }
}

/** Structured log + optional outbound webhook (Slack/Teams/PagerDuty bridge). */
async function deliver(alert: Alert): Promise<void> {
  const log = alert.severity === "critical" ? logger.error.bind(logger) : logger.warn.bind(logger);
  log({ alert }, `[alert] ${alert.summary}`);

  if (!env.ALERT_WEBHOOK_URL) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ALERT_WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "movie-tickets-api", env: env.NODE_ENV, alert }),
      signal: controller.signal,
    });
  } catch (error) {
    logger.warn({ err: error, rule: alert.rule }, "alert webhook delivery failed");
  } finally {
    clearTimeout(timeout);
  }
}

export function recentAlerts(limit = 20): Alert[] {
  return recent.slice(0, Math.max(1, Math.min(limit, MAX_RECENT_ALERTS)));
}

/** Test helper: forget watermarks so a rule can fire again immediately. */
export function resetAlertState(): void {
  recent.length = 0;
  lastFiredAt.clear();
  lastEvaluation = null;
  paymentsInFlight.set(0);
}

export function alertRuleIds(): string[] {
  return rules.map((rule) => rule.id);
}

/** Exported for the metrics unit test: raw access to the derived rates. */
export const __internals = { counterDeltas, latencyDelta };
