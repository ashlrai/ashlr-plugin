/**
 * health-check.ts — Synthetic health probes for the status page.
 *
 * Runs every 60 seconds via setInterval in the main server process.
 * Uses AbortController with a 5 s timeout on every probe to avoid
 * stale connections. Guards against overlapping runs with a flag.
 *
 * Start it by calling startHealthCheckWorker() once from index.ts.
 */

import { insertHealthCheck } from "../db.js";
import { logger } from "./logger-shim.js";

// ---------------------------------------------------------------------------
// Component definitions
// ---------------------------------------------------------------------------

export type ComponentName =
  | "plugin-registry"
  | "api"
  | "llm-summarizer"
  | "stripe-billing"
  | "email-delivery"
  | "docs";

interface ProbeTarget {
  component: ComponentName;
  url: string;
  /** If true, any non-5xx response is treated as ok (for opaque upstreams). */
  anyNon5xxOk?: boolean;
}

const PROBE_TIMEOUT_MS = 5_000;
const INTERVAL_MS      = 60_000;

function getTargets(): ProbeTarget[] {
  const apiBase    = process.env["API_BASE_URL"]      ?? "https://api.ashlr.ai";
  const pluginBase = process.env["PLUGIN_BASE_URL"]   ?? "https://plugin.ashlr.ai";
  const docsBase   = process.env["DOCS_BASE_URL"]     ?? "https://docs.ashlr.ai";

  return [
    { component: "plugin-registry",  url: `${pluginBase}/`                    },
    { component: "api",              url: `${apiBase}/readyz`                  },
    { component: "llm-summarizer",   url: "https://api.x.ai",                  anyNon5xxOk: true },
    { component: "stripe-billing",   url: "https://api.stripe.com/v1/health",  anyNon5xxOk: true },
    { component: "email-delivery",   url: "https://api.sendgrid.com",            anyNon5xxOk: true },
    { component: "docs",             url: `${docsBase}/`                       },
  ];
}

// ---------------------------------------------------------------------------
// Single probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  component: ComponentName;
  status: "ok" | "degraded" | "down";
  latencyMs: number | null;
  errorText: string | null;
}

async function probe(target: ProbeTarget): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await fetch(target.url, {
      method: "GET",
      signal: controller.signal,
      // Don't follow redirects for pure liveness — a redirect is still "up"
      redirect: "follow",
      headers: { "User-Agent": "ashlr-health-check/1.0" },
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - start;

    if (res.status >= 500) {
      return {
        component: target.component,
        status: "down",
        latencyMs,
        errorText: `HTTP ${res.status}`,
      };
    }

    // For opaque upstreams (Stripe, SendGrid, xAI) any non-5xx is "ok"
    if (target.anyNon5xxOk || res.status < 400) {
      const status = latencyMs > 3_000 ? "degraded" : "ok";
      return { component: target.component, status, latencyMs, errorText: null };
    }

    // 4xx on our own services = degraded (config issue, not fully down)
    return {
      component: target.component,
      status: "degraded",
      latencyMs,
      errorText: `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      component: target.component,
      status: "down",
      latencyMs,
      errorText: isTimeout ? "timeout" : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

let _running = false;
let _intervalHandle: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  if (_running) return; // guard against overlap
  _running = true;

  const targets = getTargets();
  const results = await Promise.allSettled(targets.map(probe));

  for (const result of results) {
    if (result.status === "fulfilled") {
      const r = result.value;
      try {
        insertHealthCheck(r.component, r.status, r.latencyMs, r.errorText);
      } catch (err) {
        logger(`[health-check] db write failed for ${r.component}: ${String(err)}`);
      }
    } else {
      logger(`[health-check] probe rejected: ${String(result.reason)}`);
    }
  }

  _running = false;
}

export function startHealthCheckWorker(): void {
  if (_intervalHandle) return; // already started

  // Run immediately on start, then every INTERVAL_MS
  void runOnce();
  _intervalHandle = setInterval(() => { void runOnce(); }, INTERVAL_MS);

  // Allow process to exit even if this interval is still live
  if (typeof _intervalHandle === "object" && _intervalHandle !== null && "unref" in _intervalHandle) {
    (_intervalHandle as { unref(): void }).unref();
  }
}

export function stopHealthCheckWorker(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  _running = false;
}

/** Exposed for tests. */
export { runOnce as _runOnce };
