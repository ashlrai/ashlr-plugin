/**
 * Tests for scripts/cloud-smoke-test.ts
 *
 * Uses a Bun.serve stub — no real network calls.
 * Verifies: pass/fail/skip logic, timing field, exit-code semantics.
 */

import { describe, expect, test, afterAll } from "bun:test";
import {
  checkHealth,
  checkTelemetry,
  checkUserMe,
  checkLlmSummarize,
  checkStatsAggregate,
  runAll,
  formatResults,
  type SmokeConfig,
  type CheckResult,
} from "../../scripts/cloud-smoke-test.ts";

// ---------------------------------------------------------------------------
// Stub server factory
// ---------------------------------------------------------------------------

interface StubRoute {
  method?: string;
  path: string;
  status: number;
  body: unknown;
}

function makeStubFetch(routes: StubRoute[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const pathname = url.pathname;

    for (const route of routes) {
      const routeMethod = (route.method ?? "GET").toUpperCase();
      if (routeMethod === method && route.path === pathname) {
        return new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}

// ---------------------------------------------------------------------------
// Standard happy-path routes
// ---------------------------------------------------------------------------

const HAPPY_ROUTES: StubRoute[] = [
  { method: "GET",  path: "/healthz",             status: 200, body: { ok: true } },
  { method: "GET",  path: "/readyz",              status: 200, body: { ok: true } },
  { method: "POST", path: "/v1/events",           status: 200, body: { accepted: 1 } },
  { method: "GET",  path: "/user/me",             status: 200, body: { userId: "u1", email: "test@example.com", tier: "pro" } },
  { method: "POST", path: "/llm/summarize",    status: 200, body: { summary: "A fox jumped.", modelUsed: "grok-4-1-fast-reasoning", inputTokens: 20, outputTokens: 5, cost: 0.000004 } },
  { method: "GET",  path: "/stats/aggregate",  status: 200, body: { machine_count: 2, total_calls: 150, total_tokens_saved: 7500 } },
];

function happyCfg(proToken?: string): SmokeConfig {
  return {
    apiUrl: "http://stub.local",
    proToken,
    fetchImpl: makeStubFetch(HAPPY_ROUTES) as unknown as typeof fetch,
    silent: true,
  };
}

// ---------------------------------------------------------------------------
// Check 1 — healthz + readyz
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
  test("passes when both /healthz and /readyz return {ok:true}", async () => {
    const r = await checkHealth(happyCfg());
    expect(r.status).toBe("pass");
    expect(r.name).toBe("healthz+readyz");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("fails when /healthz returns 500", async () => {
    const f = makeStubFetch([
      { method: "GET", path: "/healthz", status: 500, body: { ok: false } },
      { method: "GET", path: "/readyz",  status: 200, body: { ok: true } },
    ]);
    const r = await checkHealth({ apiUrl: "http://stub.local", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("500");
  });

  test("passes regardless of body shape when HTTP status is 200", async () => {
    // v1.27.1: production /readyz returns { db, checks } (Kubernetes-style)
    // and /healthz returns { status, version, uptimeSeconds }. The runner
    // relies on HTTP 200, not a specific body shape, since Hono backend
    // contract evolved. This test pins that contract change.
    const f = makeStubFetch([
      { method: "GET", path: "/healthz", status: 200, body: { status: "ok", version: "1.27.1", uptimeSeconds: 42 } },
      { method: "GET", path: "/readyz",  status: 200, body: { db: "ok", checks: { sqlite: "ok" } } },
    ]);
    const r = await checkHealth({ apiUrl: "http://stub.local", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Check 2 — telemetry
// ---------------------------------------------------------------------------

describe("checkTelemetry", () => {
  test("passes when POST /v1/events returns {accepted:N}", async () => {
    const r = await checkTelemetry(happyCfg());
    expect(r.status).toBe("pass");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("fails when server returns 500", async () => {
    const f = makeStubFetch([
      { method: "POST", path: "/v1/events", status: 500, body: { error: "db error" } },
    ]);
    const r = await checkTelemetry({ apiUrl: "http://stub.local", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
  });

  test("fails when response missing 'accepted' field", async () => {
    const f = makeStubFetch([
      { method: "POST", path: "/v1/events", status: 200, body: { result: "ok" } },
    ]);
    const r = await checkTelemetry({ apiUrl: "http://stub.local", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Check 3 — user/me
// ---------------------------------------------------------------------------

describe("checkUserMe", () => {
  test("skips when no Pro token", async () => {
    const r = await checkUserMe(happyCfg(/* no token */));
    expect(r.status).toBe("skip");
    expect(r.ms).toBe(0);
  });

  test("passes with valid token", async () => {
    const r = await checkUserMe(happyCfg("test-token"));
    expect(r.status).toBe("pass");
  });

  test("fails when server returns 401", async () => {
    const f = makeStubFetch([
      { method: "GET", path: "/user/me", status: 401, body: { error: "Unauthorized" } },
    ]);
    const r = await checkUserMe({ apiUrl: "http://stub.local", proToken: "bad-token", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
  });

  test("fails when response missing userId or tier", async () => {
    const f = makeStubFetch([
      { method: "GET", path: "/user/me", status: 200, body: { email: "test@example.com" } },
    ]);
    const r = await checkUserMe({ apiUrl: "http://stub.local", proToken: "tok", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Check 4 — llm/summarize
// ---------------------------------------------------------------------------

describe("checkLlmSummarize", () => {
  test("skips when no Pro token", async () => {
    const r = await checkLlmSummarize(happyCfg());
    expect(r.status).toBe("skip");
  });

  test("passes with valid token and good response", async () => {
    const r = await checkLlmSummarize(happyCfg("test-token"));
    expect(r.status).toBe("pass");
  });

  test("passes (not fail) when 429 has a known cap code", async () => {
    const f = makeStubFetch([
      { method: "POST", path: "/llm/summarize", status: 429, body: { error: "daily cap reached", code: "daily_cap" } },
    ]);
    const r = await checkLlmSummarize({ apiUrl: "http://stub.local", proToken: "tok", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("pass");
  });

  test("fails when 429 has unknown code", async () => {
    const f = makeStubFetch([
      { method: "POST", path: "/llm/summarize", status: 429, body: { error: "mystery", code: "unknown_code" } },
    ]);
    const r = await checkLlmSummarize({ apiUrl: "http://stub.local", proToken: "tok", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Check 5 — stats/aggregate
// ---------------------------------------------------------------------------

describe("checkStatsAggregate", () => {
  test("skips when no Pro token", async () => {
    const r = await checkStatsAggregate(happyCfg());
    expect(r.status).toBe("skip");
  });

  test("passes when machine_count is a number", async () => {
    const r = await checkStatsAggregate(happyCfg("test-token"));
    expect(r.status).toBe("pass");
  });

  test("fails when machine_count missing", async () => {
    const f = makeStubFetch([
      { method: "GET", path: "/stats/aggregate", status: 200, body: { total_calls: 10 } },
    ]);
    const r = await checkStatsAggregate({ apiUrl: "http://stub.local", proToken: "tok", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// runAll integration
// ---------------------------------------------------------------------------

describe("runAll", () => {
  test("all pass when stub returns happy routes with Pro token", async () => {
    const results = await runAll(happyCfg("test-token"));
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe("pass");
    }
  });

  test("Pro checks skip when no token (4 pass + 3 skip)", async () => {
    const results = await runAll(happyCfg(/* no token */));
    const passed = results.filter((r) => r.status === "pass");
    const skipped = results.filter((r) => r.status === "skip");
    expect(passed.length).toBe(2); // health + telemetry
    expect(skipped.length).toBe(3); // user/me, summarize, aggregate
  });

  test("remaining checks skip when healthz fails", async () => {
    const f = makeStubFetch([
      { method: "GET", path: "/healthz", status: 503, body: { ok: false } },
    ]);
    const results = await runAll({ apiUrl: "http://stub.local", proToken: "tok", fetchImpl: f as unknown as typeof fetch, silent: true });
    expect(results[0]!.status).toBe("fail");
    for (const r of results.slice(1)) {
      expect(r.status).toBe("skip");
    }
  });

  test("timing field populated for non-skipped checks", async () => {
    const results = await runAll(happyCfg("test-token"));
    for (const r of results) {
      if (r.status !== "skip") {
        expect(typeof r.ms).toBe("number");
        expect(r.ms).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// formatResults
// ---------------------------------------------------------------------------

describe("formatResults", () => {
  test("includes pass/fail/skip counts in output", () => {
    const results: CheckResult[] = [
      { name: "a", status: "pass", ms: 10 },
      { name: "b", status: "fail", ms: 5, detail: "boom" },
      { name: "c", status: "skip", ms: 0 },
    ];
    const out = formatResults(results);
    expect(out).toContain("1 passed");
    expect(out).toContain("1 failed");
    expect(out).toContain("1 skipped");
    expect(out).toContain("boom");
  });
});
