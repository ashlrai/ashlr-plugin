#!/usr/bin/env bun
/**
 * cloud-smoke-test.ts — Automated smoke runner for the ashlr cloud backend.
 *
 * Reads:
 *   ASHLR_API_URL     (default: https://api.ashlr.ai)
 *   ASHLR_PRO_TOKEN   (optional — Pro-gated checks skip when absent)
 *
 * Runs 5 checks matching server/docs/cloud-smoke-tests.md:
 *   1. /healthz + /readyz reachable
 *   2. POST /v1/events round-trip
 *   3. (Pro) GET /user/me Bearer validation
 *   4. (Pro) POST /v1/llm/summarize round-trip
 *   5. (Pro) GET /v1/stats/aggregate shape
 *
 * Each result: { name, status: "pass"|"fail"|"skip", ms, detail? }
 * Exit 0 if all pass/skip. Exit 1 if any fail.
 *
 * CI usage:
 *   ASHLR_API_URL=https://staging.ashlr.ai bun run scripts/cloud-smoke-test.ts
 */

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  detail?: string;
}

export interface SmokeConfig {
  apiUrl: string;
  proToken?: string;
  /** Override fetch for testing */
  fetchImpl?: typeof fetch;
  /** Suppress console output (used in tests) */
  silent?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

function skip(name: string): CheckResult {
  return { name, status: "skip", ms: 0 };
}

// ---------------------------------------------------------------------------
// Check 1 — /healthz + /readyz
// ---------------------------------------------------------------------------

export async function checkHealth(cfg: SmokeConfig): Promise<CheckResult> {
  const name = "healthz+readyz";
  const f = cfg.fetchImpl ?? fetch;

  const { ms } = await timed(async () => {
    for (const path of ["/healthz", "/readyz"]) {
      const res = await f(`${cfg.apiUrl}${path}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`${path} returned ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (body["ok"] !== true) throw new Error(`${path} body.ok !== true`);
    }
  }).catch((err: unknown) => {
    return { ms: 0, error: String(err) };
  });

  // Re-run cleanly to capture ms properly
  let ms2 = 0;
  let detail: string | undefined;
  try {
    const t = await timed(async () => {
      for (const path of ["/healthz", "/readyz"]) {
        const res = await f(`${cfg.apiUrl}${path}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`${path} returned ${res.status}`);
        const body = await res.json() as Record<string, unknown>;
        if (body["ok"] !== true) throw new Error(`${path} body.ok !== true`);
      }
    });
    ms2 = t.ms;
  } catch (err: unknown) {
    detail = String(err);
    return { name, status: "fail", ms: ms2, detail };
  }
  void ms;
  return { name, status: "pass", ms: ms2 };
}

// ---------------------------------------------------------------------------
// Check 2 — POST /v1/events round-trip
// ---------------------------------------------------------------------------

export async function checkTelemetry(cfg: SmokeConfig): Promise<CheckResult> {
  const name = "POST /v1/events";
  const f = cfg.fetchImpl ?? fetch;

  let ms = 0;
  try {
    const t = await timed(async () => {
      const res = await f(`${cfg.apiUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "smoke0000000000ff",
          events: [
            {
              ts: Math.floor(Date.now() / 1000),
              kind: "version",
              sessionId: "smoke0000000000ff",
              pluginVersion: "1.27.0",
              bunVersion: "1.0.0",
              platform: "darwin",
              arch: "arm64",
            },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (typeof body["accepted"] !== "number") {
        throw new Error(`expected numeric 'accepted', got: ${JSON.stringify(body)}`);
      }
    });
    ms = t.ms;
  } catch (err: unknown) {
    return { name, status: "fail", ms, detail: String(err) };
  }
  return { name, status: "pass", ms };
}

// ---------------------------------------------------------------------------
// Check 3 — GET /user/me (Pro)
// ---------------------------------------------------------------------------

export async function checkUserMe(cfg: SmokeConfig): Promise<CheckResult> {
  const name = "GET /user/me";
  if (!cfg.proToken) return skip(name);
  const f = cfg.fetchImpl ?? fetch;

  let ms = 0;
  try {
    const t = await timed(async () => {
      const res = await f(`${cfg.apiUrl}/user/me`, {
        headers: { Authorization: `Bearer ${cfg.proToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (!body["userId"] || !body["tier"]) {
        throw new Error(`missing userId/tier in response: ${JSON.stringify(body)}`);
      }
    });
    ms = t.ms;
  } catch (err: unknown) {
    return { name, status: "fail", ms, detail: String(err) };
  }
  return { name, status: "pass", ms };
}

// ---------------------------------------------------------------------------
// Check 4 — POST /v1/llm/summarize (Pro)
// ---------------------------------------------------------------------------

export async function checkLlmSummarize(cfg: SmokeConfig): Promise<CheckResult> {
  const name = "POST /v1/llm/summarize";
  if (!cfg.proToken) return skip(name);
  const f = cfg.fetchImpl ?? fetch;

  let ms = 0;
  try {
    const t = await timed(async () => {
      const res = await f(`${cfg.apiUrl}/v1/llm/summarize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.proToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "The quick brown fox jumps over the lazy dog. ".repeat(10),
          systemPrompt: "Summarize in one sentence.",
          toolName: "ashlr__read",
          maxTokens: 80,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        // Rate-limited or capped — not a failure; check code field
        const body = await res.json() as Record<string, unknown>;
        const code = body["code"];
        if (!["rate_limit", "daily_cap", "cost_cap"].includes(String(code))) {
          throw new Error(`unexpected 429 code: ${code}`);
        }
        // Treat expected cap codes as pass (system working correctly)
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (!body["summary"] || !body["modelUsed"]) {
        throw new Error(`missing summary/modelUsed: ${JSON.stringify(body)}`);
      }
    });
    ms = t.ms;
  } catch (err: unknown) {
    return { name, status: "fail", ms, detail: String(err) };
  }
  return { name, status: "pass", ms };
}

// ---------------------------------------------------------------------------
// Check 5 — GET /v1/stats/aggregate (Pro)
// ---------------------------------------------------------------------------

export async function checkStatsAggregate(cfg: SmokeConfig): Promise<CheckResult> {
  const name = "GET /v1/stats/aggregate";
  if (!cfg.proToken) return skip(name);
  const f = cfg.fetchImpl ?? fetch;

  let ms = 0;
  try {
    const t = await timed(async () => {
      const res = await f(`${cfg.apiUrl}/v1/stats/aggregate`, {
        headers: { Authorization: `Bearer ${cfg.proToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (typeof body["machine_count"] !== "number") {
        throw new Error(`missing numeric machine_count: ${JSON.stringify(body)}`);
      }
    });
    ms = t.ms;
  } catch (err: unknown) {
    return { name, status: "fail", ms, detail: String(err) };
  }
  return { name, status: "pass", ms };
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

export async function runAll(cfg: SmokeConfig): Promise<CheckResult[]> {
  // Health must pass before we bother with the rest
  const health = await checkHealth(cfg);
  const results: CheckResult[] = [health];

  if (health.status === "fail") {
    // Skip remaining checks — server is unreachable
    for (const name of [
      "POST /v1/events",
      "GET /user/me",
      "POST /v1/llm/summarize",
      "GET /v1/stats/aggregate",
    ]) {
      results.push({ name, status: "skip", ms: 0, detail: "skipped: healthz failed" });
    }
    return results;
  }

  results.push(
    await checkTelemetry(cfg),
    await checkUserMe(cfg),
    await checkLlmSummarize(cfg),
    await checkStatsAggregate(cfg),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatResults(results: CheckResult[]): string {
  const lines: string[] = ["", "ashlr cloud smoke test", "─".repeat(40)];
  for (const r of results) {
    const icon = r.status === "pass" ? "✓" : r.status === "skip" ? "–" : "✗";
    const ms = r.status !== "skip" ? `  ${r.ms}ms` : "";
    const detail = r.detail ? `  (${r.detail})` : "";
    lines.push(`  ${icon} ${r.name}${ms}${detail}`);
  }
  lines.push("─".repeat(40));

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  lines.push(`  ${passed} passed · ${failed} failed · ${skipped} skipped`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const apiUrl = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
  const proToken = process.env["ASHLR_PRO_TOKEN"];

  const cfg: SmokeConfig = { apiUrl, proToken };
  const results = await runAll(cfg);

  process.stdout.write(formatResults(results));

  const anyFail = results.some((r) => r.status === "fail");
  process.exit(anyFail ? 1 : 0);
}
