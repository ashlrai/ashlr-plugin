/**
 * metrics.ts — Prometheus metrics via prom-client.
 *
 * Exported counters/gauges/histograms are incremented by route handlers.
 * GET /metrics returns the text exposition format, gated by IP allowlist
 * or HTTP Basic Auth (METRICS_USER + METRICS_PASS).
 *
 * No-op if prom-client is absent — but it's a hard dep so that won't happen.
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import type { Context } from "hono";
import { timingSafeEqual } from "crypto";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// Gauges (point-in-time DB reads — refreshed at scrape time)
// ---------------------------------------------------------------------------

export const gUsersTotal = new Gauge({
  name: "ashlr_users_total",
  help: "Total registered users",
  registers: [registry],
  collect() {
    try {
      const row = getDb()
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users")
        .get();
      this.set(row?.n ?? 0);
    } catch { this.set(0); }
  },
});

export const gSubscriptionsActive = new Gauge({
  name: "ashlr_subscriptions_active",
  help: "Active subscriptions",
  registers: [registry],
  collect() {
    try {
      const row = getDb()
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'",
        )
        .get();
      this.set(row?.n ?? 0);
    } catch { this.set(0); }
  },
});

export const gStatsUploadsTotal = new Gauge({
  name: "ashlr_stats_uploads_total",
  help: "Total stats upload records",
  registers: [registry],
  collect() {
    try {
      const row = getDb()
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stats_uploads")
        .get();
      this.set(row?.n ?? 0);
    } catch { this.set(0); }
  },
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const cHttpRequests = new Counter({
  name: "ashlr_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"] as const,
  registers: [registry],
});

export const cLlmRequests = new Counter({
  name: "ashlr_llm_requests_total",
  help: "Total LLM requests by user tier",
  labelNames: ["tier"] as const,
  registers: [registry],
});

export const cMagicLinksSent = new Counter({
  name: "ashlr_magic_links_sent_total",
  help: "Total magic link emails sent",
  registers: [registry],
});

export const cCrashReports = new Counter({
  name: "ashlr_crash_reports_total",
  help: "Total opt-in crash reports received from plugin clients",
  labelNames: ["platform"] as const,
  registers: [registry],
});

export const cTelemetryEventsAccepted = new Counter({
  name: "ashlr_telemetry_events_accepted_total",
  help: "Total opt-in telemetry events accepted into storage (post-validation)",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const cTelemetryEventsDropped = new Counter({
  name: "ashlr_telemetry_events_dropped_total",
  help: "Telemetry events dropped server-side (path-shaped values, schema invalid, rate-limited)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export const hHttpDuration = new Histogram({
  name: "ashlr_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const hLlmTokens = new Histogram({
  name: "ashlr_llm_request_tokens",
  help: "LLM request token counts",
  labelNames: ["type"] as const,
  buckets: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// /metrics handler
// ---------------------------------------------------------------------------

function isAllowed(c: Context): boolean {
  const allowedIps = process.env["METRICS_ALLOWED_IPS"];
  const metricsUser = process.env["METRICS_USER"];
  const metricsPass = process.env["METRICS_PASS"];

  // IP allowlist check
  if (allowedIps) {
    const ips = allowedIps.split(",").map((s) => s.trim());
    // Fly.io sets Fly-Client-IP; fall back to CF-Connecting-IP then x-forwarded-for
    const clientIp =
      c.req.header("fly-client-ip") ??
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "";
    if (ips.includes(clientIp)) return true;
  }

  // Basic Auth check — constant-time compare to prevent timing-oracle attacks
  if (metricsUser && metricsPass) {
    const auth = c.req.header("authorization") ?? "";
    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      // Split on first colon only — password may contain colons
      const colonIdx = decoded.indexOf(":");
      if (colonIdx !== -1) {
        const u = decoded.slice(0, colonIdx);
        const p = decoded.slice(colonIdx + 1);
        // Pad both sides to equal length before compare to avoid length leak
        const uBuf = Buffer.from(u);
        const pBuf = Buffer.from(p);
        const expectedUBuf = Buffer.from(metricsUser);
        const expectedPBuf = Buffer.from(metricsPass);
        // Constant-time: allocate equal-length buffers, then compare
        const maxULen = Math.max(uBuf.length, expectedUBuf.length);
        const maxPLen = Math.max(pBuf.length, expectedPBuf.length);
        const uPad  = Buffer.concat([uBuf,  Buffer.alloc(maxULen - uBuf.length)]);
        const euPad = Buffer.concat([expectedUBuf, Buffer.alloc(maxULen - expectedUBuf.length)]);
        const pPad  = Buffer.concat([pBuf,  Buffer.alloc(maxPLen - pBuf.length)]);
        const epPad = Buffer.concat([expectedPBuf, Buffer.alloc(maxPLen - expectedPBuf.length)]);
        const uMatch = timingSafeEqual(uPad, euPad);
        const pMatch = timingSafeEqual(pPad, epPad);
        // Both length equality AND content equality must hold
        if (uMatch && pMatch && uBuf.length === expectedUBuf.length && pBuf.length === expectedPBuf.length) return true;
      }
    }
  }

  // If neither guard is configured, block — never expose metrics publicly.
  return false;
}

export async function metricsHandler(c: Context): Promise<Response> {
  if (!isAllowed(c)) {
    return c.text("Forbidden", 403);
  }
  const output = await registry.metrics();
  return c.text(output, 200, { "Content-Type": registry.contentType });
}
