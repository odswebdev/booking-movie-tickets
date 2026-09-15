/**
 * Dependency-free Prometheus-style metrics registry (ТЗ §1.7 — observability).
 *
 * Why not `prom-client`: the API only needs counters, gauges and a handful of
 * histograms, and the registry must work identically in the JSON/zero-infra
 * mode and in tests (no global state leaking between suites).
 *
 * Everything is cumulative; the alert evaluator (`services/alerts.ts`) derives
 * rates and quantiles from *deltas* between two evaluations, which is exactly
 * what a Prometheus `rate()` does.
 */

export type LabelValue = string | number | boolean | null | undefined;
export type Labels = Record<string, LabelValue>;

/** Metric buckets tuned for HTTP latency (ms) — the only histogram we need. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

function normalizeLabels(labels: Labels | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${labels[key]}`).join(",");
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderLabels(labels: Record<string, string>, extra: Record<string, string> = {}): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((key) => `${key}="${escapeValue(all[key] ?? "")}"`).join(",")}}`;
}

export interface HistogramSeries {
  labels: Record<string, string>;
  /** Cumulative count per bucket (bucket bounds from `bounds`). */
  counts: number[];
  sum: number;
  count: number;
}

class Counter {
  private readonly series = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  inc(labels?: Labels, delta = 1): void {
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    const entry = this.series.get(key);
    if (entry) entry.value += delta;
    else this.series.set(key, { labels: normalized, value: delta });
  }

  get(labels?: Labels): number {
    return this.series.get(labelKey(normalizeLabels(labels)))?.value ?? 0;
  }

  all(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.series.values()];
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    const entries = this.all();
    if (entries.length === 0) {
      // Prometheus prefers a stable time series over a missing one.
      lines.push(`${this.name} 0`);
      return lines.join("\n");
    }
    for (const entry of entries) {
      lines.push(`${this.name}${renderLabels(entry.labels)} ${entry.value}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private readonly series = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  set(value: number, labels?: Labels): void {
    const normalized = normalizeLabels(labels);
    this.series.set(labelKey(normalized), { labels: normalized, value });
  }

  inc(delta = 1, labels?: Labels): void {
    this.set(this.get(labels) + delta, labels);
  }

  /** Clamped at zero — a gauge that drifts negative is always a bug. */
  dec(delta = 1, labels?: Labels): void {
    this.set(Math.max(0, this.get(labels) - delta), labels);
  }

  get(labels?: Labels): number {
    return this.series.get(labelKey(normalizeLabels(labels)))?.value ?? 0;
  }

  all(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.series.values()];
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    const entries = this.all();
    if (entries.length === 0) {
      lines.push(`${this.name} 0`);
      return lines.join("\n");
    }
    for (const entry of entries) {
      lines.push(`${this.name}${renderLabels(entry.labels)} ${entry.value}`);
    }
    return lines.join("\n");
  }
}

class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly bounds: number[],
  ) {}

  observe(value: number, labels?: Labels): void {
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels: normalized,
        counts: Array.from({ length: this.bounds.length }, () => 0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let index = 0; index < this.bounds.length; index += 1) {
      if (value <= (this.bounds[index] ?? Number.POSITIVE_INFINITY)) {
        entry.counts[index] = (entry.counts[index] ?? 0) + 1;
      }
    }
  }

  all(): HistogramSeries[] {
    return [...this.series.values()];
  }

  /** Snapshot with a stable shape (used by the alert evaluator). */
  snapshot(): Map<string, HistogramSeries> {
    return new Map(
      [...this.series.entries()].map(([key, entry]) => [key, { ...entry, counts: [...entry.counts] }]),
    );
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.all()) {
      for (let index = 0; index < this.bounds.length; index += 1) {
        lines.push(
          `${this.name}_bucket${renderLabels(entry.labels, { le: String(this.bounds[index]) })} ${entry.counts[index]}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    if (this.all().length === 0) {
      for (const bound of this.bounds) lines.push(`${this.name}_bucket{le="${bound}"} 0`);
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string, help: string): Counter {
    const existing = this.counters.get(name);
    if (existing) return existing;
    const counter = new Counter(name, help);
    this.counters.set(name, counter);
    return counter;
  }

  gauge(name: string, help: string): Gauge {
    const existing = this.gauges.get(name);
    if (existing) return existing;
    const gauge = new Gauge(name, help);
    this.gauges.set(name, gauge);
    return gauge;
  }

  histogram(name: string, help: string, bounds: number[] = LATENCY_BUCKETS_MS): Histogram {
    const existing = this.histograms.get(name);
    if (existing) return existing;
    const histogram = new Histogram(name, help, bounds);
    this.histograms.set(name, histogram);
    return histogram;
  }

  histogramByName(name: string): Histogram | undefined {
    return this.histograms.get(name);
  }

  counterByName(name: string): Counter | undefined {
    return this.counters.get(name);
  }

  /** Names of every registered counter (used by the alert evaluator). */
  counterNames(): string[] {
    return [...this.counters.keys()];
  }

  /** Prometheus text exposition (scrape target for `/api/metrics`). */
  render(): string {
    const blocks: string[] = [];
    for (const counter of [...this.counters.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      blocks.push(counter.render());
    }
    for (const gauge of [...this.gauges.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      blocks.push(gauge.render());
    }
    for (const histogram of [...this.histograms.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      blocks.push(histogram.render());
    }
    return `${blocks.join("\n\n")}\n`;
  }

  /** Human/agent friendly JSON view for `/api/metrics/summary`. */
  snapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; sumMs: number; avgMs: number; p95Ms: number }>;
  } {
    const counters: Record<string, number> = {};
    for (const counter of this.counters.values()) {
      for (const entry of counter.all())
        counters[`${counter.name}${renderLabels(entry.labels)}`] = entry.value;
    }
    const gauges: Record<string, number> = {};
    for (const gauge of this.gauges.values()) {
      for (const entry of gauge.all()) gauges[`${gauge.name}${renderLabels(entry.labels)}`] = entry.value;
    }
    const histograms: Record<string, { count: number; sumMs: number; avgMs: number; p95Ms: number }> = {};
    for (const histogram of this.histograms.values()) {
      for (const entry of histogram.all()) {
        histograms[`${histogram.name}${renderLabels(entry.labels)}`] = {
          count: entry.count,
          sumMs: Math.round(entry.sum),
          avgMs: entry.count > 0 ? Math.round((entry.sum / entry.count) * 100) / 100 : 0,
          p95Ms: quantileOfSeries(histogram.bounds, entry, 0.95),
        };
      }
    }
    return { counters, gauges, histograms };
  }

  /** Test helper: wipe every series so suites stay independent. */
  reset(): void {
    for (const counter of this.counters.values()) counter.reset();
    for (const gauge of this.gauges.values()) gauge.reset();
    for (const histogram of this.histograms.values()) histogram.reset();
  }
}

/**
 * Estimator for the q-quantile of a histogram series (linear interpolation
 * inside the bucket, Prometheus' own approach). Exact enough for alerts.
 */
export function quantileOfSeries(bounds: number[], series: HistogramSeries, q: number): number {
  if (series.count === 0) return 0;
  const target = q * series.count;
  let previous = 0;
  let previousBound = 0;
  for (let index = 0; index < bounds.length; index += 1) {
    const cumulative = series.counts[index] ?? 0;
    const bound = bounds[index] ?? 0;
    if (cumulative >= target) {
      const inBucket = cumulative - previous;
      const position = inBucket === 0 ? 0 : (target - previous) / inBucket;
      return Math.round((previousBound + position * (bound - previousBound)) * 100) / 100;
    }
    previous = cumulative;
    previousBound = bound;
  }
  return previousBound;
}

export const metrics = new MetricsRegistry();

/* --------------------------------------------------------------------------
 * Domain metrics (ТЗ §1.7: latency, 401-rate, payment_failed and more).
 * ------------------------------------------------------------------------ */

export const httpRequests = metrics.counter(
  "http_requests_total",
  "HTTP requests by method, route template and status code",
);
export const httpDuration = metrics.histogram(
  "http_request_duration_ms",
  "HTTP request latency in milliseconds",
);
export const httpUnauthorized = metrics.counter(
  "http_unauthorized_total",
  "Rejected requests (401) — a spike means expired tokens or a credential attack",
);
export const paymentOutcomes = metrics.counter(
  "payment_outcomes_total",
  "Payment settle attempts by provider and outcome (succeeded | failed)",
);
export const seatConflicts = metrics.counter(
  "seat_conflicts_total",
  "409 seat_unavailable responses — booking contention on a showtime",
);
export const smsQuotaHits = metrics.counter("sms_quota_hits_total", "SMS codes refused by the 5/hour quota");
export const queueJobs = metrics.counter(
  "queue_jobs_total",
  "Background jobs by queue and result (ok | failed)",
);
export const notificationFailures = metrics.counter(
  "notification_failures_total",
  "Ticket/refund notification failures by kind",
);
export const circuitBreakerState = metrics.gauge(
  "payment_provider_circuit_open",
  "1 when the PSP circuit breaker is open for a provider, 0 otherwise",
);
export const paymentsInFlight = metrics.gauge(
  "payments_in_flight",
  "Payment intents waiting for the SMS code confirmation",
);
export const alertsFired = metrics.counter("alerts_fired_total", "Alert rules that crossed their threshold");

export interface HttpObservation {
  method: string;
  /** Route template (`/api/bookings/:bookingId`), never the raw URL. */
  route: string;
  status: number;
  durationMs: number;
}

export function recordHttpRequest({ method, route, status, durationMs }: HttpObservation): void {
  const labels = { method, route, status: String(status) };
  httpRequests.inc(labels);
  httpDuration.observe(durationMs, { method, route });
  if (status === 401) httpUnauthorized.inc({ route });
  if (status === 409) seatConflicts.inc({ route });
}

export function recordPaymentOutcome(provider: string, outcome: "succeeded" | "failed"): void {
  paymentOutcomes.inc({ provider, outcome });
}

export function recordQueueJob(queue: string, ok: boolean): void {
  queueJobs.inc({ queue, result: ok ? "ok" : "failed" });
}
