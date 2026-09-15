import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { evaluateAlerts, recentAlerts, resetAlertState, alertRuleIds } from "../src/services/alerts.js";
import { metrics, quantileOfSeries } from "../src/utils/metrics.js";
import { setupTestApp, teardownTestApp, type TestContext } from "./setup.js";

/**
 * Observability (ТЗ §1.7): registry maths, the Prometheus/JSON endpoints and
 * the alert rules (latency, 401-rate, payment_failed, circuit breaker).
 */
describe("metrics + alerts", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    metrics.reset();
    resetAlertState();
    ctx = await setupTestApp("observability-");
  });

  afterEach(async () => {
    await teardownTestApp(ctx.tempDir);
  });

  it("renders counters, gauges and histogram buckets in Prometheus format", () => {
    const counter = metrics.counter("test_counter_total", "unit test counter");
    const gauge = metrics.gauge("test_gauge", "unit test gauge");
    const histogram = metrics.histogram("test_latency_ms", "unit test histogram", [10, 100]);

    counter.inc({ route: "/x" }, 2);
    counter.inc({ route: "/x" }, 3);
    gauge.set(7);
    gauge.inc(1);
    gauge.dec(3);
    for (const value of [5, 20, 90, 400]) histogram.observe(value);

    const text = metrics.render();
    expect(text).toContain('test_counter_total{route="/x"} 5');
    expect(text).toContain("test_gauge 5");
    expect(text).toContain('test_latency_ms_bucket{le="10"} 1');
    expect(text).toContain('test_latency_ms_bucket{le="100"} 3');
    expect(text).toContain('test_latency_ms_bucket{le="+Inf"} 4');
    expect(text).toContain("test_latency_ms_count 4");

    // p95 sits in the +Inf bucket (400 > 100): interpolation is monotonic.
    const series = histogram.all()[0]!;
    expect(quantileOfSeries([10, 100], series, 0.5)).toBeGreaterThan(0);
    expect(quantileOfSeries([10, 100], series, 0.95)).toBeGreaterThanOrEqual(100);
  });

  it("exposes /api/metrics (text), /summary and /alerts (JSON)", async () => {
    const calls = await Promise.all([
      request(ctx.app).get("/api/movies").expect(200),
      request(ctx.app).get("/api/health").expect(200),
      request(ctx.app).get("/api/bookings").expect(401),
    ]);
    expect(calls).toHaveLength(3);

    const prometheus = await request(ctx.app).get("/api/metrics").expect(200);
    expect(prometheus.headers["content-type"]).toContain("text/plain");
    expect(prometheus.text).toContain("http_requests_total");
    expect(prometheus.text).toContain("http_request_duration_ms_bucket");
    expect(prometheus.text).toContain('status="401"');

    const summary = await request(ctx.app).get("/api/metrics/summary").expect(200);
    expect(summary.body.counters['http_requests_total{method="GET",route="/api/health",status="200"}']).toBe(
      1,
    );
    expect(summary.body.counters['http_unauthorized_total{route="/api/bookings"}']).toBe(1);
    expect(summary.body.latency[0]).toMatchObject({
      path: expect.stringContaining("http_request_duration_ms"),
    });
    expect(summary.body.alertRules).toEqual(alertRuleIds());

    const alerts = await request(ctx.app).get("/api/metrics/alerts").expect(200);
    expect(alerts.body.items).toEqual([]);
  });

  it("fires the payment_failure alert once the failure rate crosses the threshold", async () => {
    const { paymentOutcomes } = await import("../src/utils/metrics.js");
    // 4 failures out of 10 settled attempts crosses the default 25%.
    for (let index = 0; index < 4; index += 1) paymentOutcomes.inc({ provider: "mock", outcome: "failed" });
    for (let index = 0; index < 6; index += 1)
      paymentOutcomes.inc({ provider: "mock", outcome: "succeeded" });

    const fired = await evaluateAlerts();
    const alert = fired.find((entry) => entry.rule === "payment_failure_rate");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("critical");
    expect(alert?.details.rate).toBeCloseTo(0.4, 5);
    expect(recentAlerts()[0]?.rule).toBe("payment_failure_rate");

    // Cooldown: the same rule does not fire again immediately…
    paymentOutcomes.inc({ provider: "mock", outcome: "failed" }, 10);
    expect((await evaluateAlerts()).some((entry) => entry.rule === "payment_failure_rate")).toBe(false);

    // …but other rules are unaffected.
    const unauthorized = await import("../src/utils/metrics.js").then((mod) => mod.httpUnauthorized);
    unauthorized.inc({ route: "/api/bookings" }, 100);
    const second = await evaluateAlerts();
    expect(second.some((entry) => entry.rule === "auth_401_rate")).toBe(true);
  });

  it("reports an open PSP circuit breaker as a critical alert", async () => {
    const { circuitBreakerState } = await import("../src/utils/metrics.js");
    circuitBreakerState.set(1, { provider: "stripe" });
    const fired = await evaluateAlerts();
    const alert = fired.find((entry) => entry.rule === "payment_provider_unavailable");
    expect(alert?.severity).toBe("critical");
    expect(alert?.details.providers).toBe("stripe");
    // Closed again → no alert on the next (cooldown-expired) evaluation.
    circuitBreakerState.set(0, { provider: "stripe" });
  });
});
