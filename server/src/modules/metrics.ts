import { Router } from "express";
import { env } from "../config/env.js";
import { alertRuleIds, recentAlerts } from "../services/alerts.js";
import { metrics } from "../utils/metrics.js";
import { ApiError } from "../utils/errors.js";

/**
 * Observability endpoints (ТЗ §1.7).
 *
 * - `GET /api/metrics`          → Prometheus text exposition (scrape target)
 * - `GET /api/metrics/summary`  → compact JSON (dashboards, smoke checks)
 * - `GET /api/metrics/alerts`   → alerts that fired recently
 *
 * Disabled entirely when METRICS_ENABLED=false; `METRICS_TOKEN` puts a bearer
 * check in front of every one of them (metrics leak traffic patterns).
 */
export const metricsRouter: Router = Router();

metricsRouter.use((req, _res, next) => {
  if (!env.METRICS_ENABLED) return next(ApiError.notFound("Metrics are disabled"));
  if (env.METRICS_TOKEN) {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (token !== env.METRICS_TOKEN) return next(ApiError.unauthorized("Metrics token required"));
  }
  next();
});

metricsRouter.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(metrics.render());
});

metricsRouter.get("/summary", (_req, res) => {
  const snapshot = metrics.snapshot();
  const paths = Object.entries(snapshot.histograms)
    .map(([key, value]) => ({ path: key, ...value }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    generatedAt: new Date().toISOString(),
    counters: snapshot.counters,
    gauges: snapshot.gauges,
    latency: paths,
    alertRules: alertRuleIds(),
  });
});

metricsRouter.get("/alerts", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ items: recentAlerts() });
});
