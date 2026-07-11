/**
 * Unit tests for hooks/sessionend-hook-health-nudge.ts
 *
 * Coverage:
 *   - Nudge #2 hook-error visibility
 *     - no current-session errors → no nudge
 *     - 3 current-session errors → nudge fired with count=3, first 2 visible
 *     - throttle: same category does not re-fire within 24h
 *     - errors from before sessionStart are ignored
 *   - Nudge #7 hook regression detector
 *     - p95 > 200ms → regression nudge with hook name
 *     - single sample > 1s (max breach) → regression nudge
 *     - p95 well under threshold → no nudge
 *     - throttle: regression nudge dedupes within window
 *   - Both nudges fire independently in the same SessionEnd
 *   - tailJsonl bounds to last N lines (large file safety net)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  TAIL_LINES_CAP,
  TAIL_BYTES_CAP,
  REGRESSION_P95_MS,
  REGRESSION_MAX_MS,
  THROTTLE_WINDOW_MS,
  buildErrorNudge,
  buildRegressionNudge,
  checkAndFireHealthNudges,
  computeErrorNudge,
  computeRegressionNudge,
  readHealthState,
  resolveSessionStartMs,
  tailJsonl,
  writeHealthState,
  type HealthNudgeState,
  type HookErrorRecord,
  type HookTimingRow,
} from "../hooks/sessionend-hook-health-nudge";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-health-nudge-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const sessionStart = "2026-05-22T10:00:00.000Z";
const sessionStartMs = Date.parse(sessionStart);
const inSession = (offsetMs: number) =>
  new Date(sessionStartMs + offsetMs).toISOString();
const beforeSession = (offsetMs: number) =>
  new Date(sessionStartMs - offsetMs).toISOString();

async function writeStats(): Promise<void> {
  const stats = {
    schemaVersion: 2,
    sessions: {
      "current": { startedAt: sessionStart, tokensSaved: 1000 },
    },
    lifetime: { tokensSaved: 1000 },
  };
  await writeFile(join(home, ".ashlr", "stats.json"), JSON.stringify(stats));
}

async function writeJsonl(name: string, rows: unknown[]): Promise<void> {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(join(home, ".ashlr", name), body);
}

const emptyState: HealthNudgeState = {
  last_error_nudge_at: 0,
  last_regression_nudge_at: 0,
};

// ---------------------------------------------------------------------------
// Nudge text builders
// ---------------------------------------------------------------------------

describe("buildErrorNudge", () => {
  test("singular count + first 2 errors + /ashlr-doctor link", () => {
    const errs: HookErrorRecord[] = [
      { ts: "t", hook: "posttooluse-genome", context: "scribe", error: "boom A" },
      { ts: "t", hook: "pretooluse-edit", context: "redirect", error: "boom B" },
      { ts: "t", hook: "session-end-consolidate", context: "push", error: "boom C" },
    ];
    const text = buildErrorNudge(3, errs);
    expect(text).toContain("3 hook errors this session.");
    expect(text).toContain("posttooluse-genome");
    expect(text).toContain("boom A");
    expect(text).toContain("pretooluse-edit");
    expect(text).toContain("boom B");
    // Third error is summarized, not printed inline.
    expect(text).not.toContain("session-end-consolidate: boom C");
    expect(text).toContain("+ 1 more");
    expect(text).toContain("/ashlr-doctor --errors");
  });

  test("singular form when count = 1", () => {
    const text = buildErrorNudge(1, [
      { ts: "t", hook: "h", context: "c", error: "one" },
    ]);
    expect(text).toContain("1 hook error this session.");
    expect(text).not.toContain("hook errors");
  });

  test("trims long error bodies", () => {
    const longErr = "x".repeat(500);
    const text = buildErrorNudge(1, [
      { ts: "t", hook: "h", context: "c", error: longErr },
    ]);
    expect(text).toContain("...");
    // Should not blast the full 500 chars into the nudge.
    expect(text.length).toBeLessThan(400);
  });
});

describe("buildRegressionNudge", () => {
  test("lists hook name + p95 + link", () => {
    const text = buildRegressionNudge([
      { hook: "posttooluse-genome", p95: 350, max: 700, samples: 12 },
    ]);
    expect(text).toContain("posttooluse-genome");
    expect(text).toContain("p95 350ms");
    expect(text).toContain("/ashlr-hook-timings --flags-only");
  });

  test("formats max as seconds when over 1s", () => {
    const text = buildRegressionNudge([
      { hook: "h", p95: 0, max: 1500, samples: 3 },
    ]);
    expect(text).toContain("1.5s");
  });
});

// ---------------------------------------------------------------------------
// computeErrorNudge — pure
// ---------------------------------------------------------------------------

describe("computeErrorNudge", () => {
  test("no records → no nudge", () => {
    const r = computeErrorNudge([], emptyState, Date.now());
    expect(r.nudgeText).toBeNull();
    expect(r.count).toBe(0);
  });

  test("3 errors → nudge fires with count=3 and first 2 visible", () => {
    const errs: HookErrorRecord[] = [
      { ts: "t", hook: "a", context: "c", error: "E1" },
      { ts: "t", hook: "b", context: "c", error: "E2" },
      { ts: "t", hook: "c", context: "c", error: "E3" },
    ];
    const r = computeErrorNudge(errs, emptyState, Date.now());
    expect(r.nudgeText).not.toBeNull();
    expect(r.nudgeText).toContain("3 hook errors");
    expect(r.nudgeText).toContain("E1");
    expect(r.nudgeText).toContain("E2");
    expect(r.count).toBe(3);
  });

  test("throttle: re-fire within 24h → no nudge", () => {
    const errs: HookErrorRecord[] = [
      { ts: "t", hook: "a", context: "c", error: "E1" },
    ];
    const now = Date.now();
    const recent: HealthNudgeState = {
      last_error_nudge_at: now - 1000, // 1s ago
      last_regression_nudge_at: 0,
    };
    const r = computeErrorNudge(errs, recent, now);
    expect(r.nudgeText).toBeNull();
    expect(r.count).toBe(1); // still reports the count for telemetry
  });

  test("throttle: fires again after 24h window", () => {
    const errs: HookErrorRecord[] = [
      { ts: "t", hook: "a", context: "c", error: "E1" },
    ];
    const now = Date.now();
    const old: HealthNudgeState = {
      last_error_nudge_at: now - THROTTLE_WINDOW_MS - 1000,
      last_regression_nudge_at: 0,
    };
    const r = computeErrorNudge(errs, old, now);
    expect(r.nudgeText).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeRegressionNudge — pure
// ---------------------------------------------------------------------------

describe("computeRegressionNudge", () => {
  function makeRows(hook: string, durations: number[]): HookTimingRow[] {
    return durations.map((d, i) => ({
      ts: inSession(i * 100),
      hook,
      tool: null,
      durationMs: d,
      outcome: "ok",
    }));
  }

  test("no records → no nudge", () => {
    const r = computeRegressionNudge([], emptyState, Date.now());
    expect(r.nudgeText).toBeNull();
    expect(r.findings).toEqual([]);
  });

  test("p95 = 500ms above 200ms threshold → regression nudge with hook name", () => {
    // n=10, p=95 → idx=8.55, sorted[8]=sorted[9]=500 → p95=500.
    const durations = [10, 10, 10, 10, 10, 10, 10, 10, 500, 500];
    const rows = makeRows("posttooluse-genome", durations);
    const r = computeRegressionNudge(rows, emptyState, Date.now());
    expect(r.nudgeText).not.toBeNull();
    expect(r.nudgeText).toContain("posttooluse-genome");
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.p95).toBeGreaterThan(REGRESSION_P95_MS);
  });

  test("single sample over 1s → max-breach nudge fires", () => {
    const rows = makeRows("slow-hook", [REGRESSION_MAX_MS + 100]);
    const r = computeRegressionNudge(rows, emptyState, Date.now());
    expect(r.nudgeText).not.toBeNull();
    expect(r.findings[0]!.max).toBeGreaterThanOrEqual(REGRESSION_MAX_MS);
    expect(r.nudgeText).toContain("slow-hook");
  });

  test("all samples well under threshold → no nudge", () => {
    const rows = makeRows("fast-hook", [10, 20, 30, 20, 10, 15, 25, 18]);
    const r = computeRegressionNudge(rows, emptyState, Date.now());
    expect(r.nudgeText).toBeNull();
    expect(r.findings).toEqual([]);
  });

  test("throttle: regression nudge dedupes within 24h", () => {
    const rows = makeRows("h", [REGRESSION_MAX_MS + 100]);
    const now = Date.now();
    const recent: HealthNudgeState = {
      last_error_nudge_at: 0,
      last_regression_nudge_at: now - 1000,
    };
    const r = computeRegressionNudge(rows, recent, now);
    expect(r.nudgeText).toBeNull();
    expect(r.findings.length).toBe(1); // findings still surfaced for telemetry
  });

  test("p95 ignored when fewer than 5 samples; max still applies", () => {
    // 3 samples all just above the p95 line but below max → no nudge.
    const rows = makeRows("h", [201, 250, 220]);
    const r = computeRegressionNudge(rows, emptyState, Date.now());
    expect(r.nudgeText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tailJsonl — bounded scan
// ---------------------------------------------------------------------------

describe("tailJsonl", () => {
  test("returns [] when file missing", () => {
    const rows = tailJsonl(join(home, ".ashlr", "nope.jsonl"));
    expect(rows).toEqual([]);
  });

  test("caps to last N lines and drops malformed lines silently", async () => {
    // 1500 valid lines + a malformed one in the middle.
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) {
      lines.push(JSON.stringify({ i }));
    }
    lines.splice(700, 0, "this is not json");
    await writeFile(join(home, ".ashlr", "big.jsonl"), lines.join("\n") + "\n");
    const rows = tailJsonl<{ i: number }>(join(home, ".ashlr", "big.jsonl"));
    // Cap honored.
    expect(rows.length).toBeLessThanOrEqual(TAIL_LINES_CAP);
    // Last record preserved.
    expect(rows[rows.length - 1]!.i).toBe(1499);
  });

  test("is truly byte bounded and drops a partial leading row", async () => {
    const path = join(home, ".ashlr", "byte-bound.jsonl");
    const huge = JSON.stringify({ payload: "x".repeat(TAIL_BYTES_CAP) });
    const last = JSON.stringify({ i: 42 });
    await writeFile(path, `${huge}\n${last}\n`);
    expect(tailJsonl<{ i: number }>(path)).toEqual([{ i: 42 }]);
  });

  test("drops a malformed torn tail but preserves the preceding row", async () => {
    const path = join(home, ".ashlr", "torn.jsonl");
    await writeFile(path, `${JSON.stringify({ i: 1 })}\n{\"i\":`);
    expect(tailJsonl<{ i: number }>(path)).toEqual([{ i: 1 }]);
  });

  test("preserves a syntactically complete final object without a newline", async () => {
    const path = join(home, ".ashlr", "complete-tail.jsonl");
    await writeFile(path, JSON.stringify({ i: 7 }));
    expect(tailJsonl<{ i: number }>(path)).toEqual([{ i: 7 }]);
  });

  test("rejects null, arrays, and primitive JSON values", async () => {
    const path = join(home, ".ashlr", "objects-only.jsonl");
    await writeFile(path, ["null", "[]", "42", '"text"', JSON.stringify({ i: 1 }), ""].join("\n"));
    expect(tailJsonl<{ i: number }>(path)).toEqual([{ i: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// State IO
// ---------------------------------------------------------------------------

describe("health-nudge state IO", () => {
  test("missing → defaults", () => {
    const s = readHealthState(home);
    expect(s.last_error_nudge_at).toBe(0);
    expect(s.last_regression_nudge_at).toBe(0);
  });

  test("round-trip", () => {
    const s: HealthNudgeState = {
      last_error_nudge_at: 123,
      last_regression_nudge_at: 456,
    };
    writeHealthState(s, home);
    const back = readHealthState(home);
    expect(back).toEqual(s);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionStartMs
// ---------------------------------------------------------------------------

describe("resolveSessionStartMs", () => {
  test("falls back to now-1h when stats missing", () => {
    const now = Date.parse("2026-05-22T12:00:00.000Z");
    const got = resolveSessionStartMs(home, now);
    expect(got).toBe(now - 60 * 60_000);
  });

  test("picks startedAt of most-active session bucket", async () => {
    await writeStats();
    const got = resolveSessionStartMs(home, Date.now());
    expect(got).toBe(sessionStartMs);
  });
});

// ---------------------------------------------------------------------------
// checkAndFireHealthNudges — orchestration
// ---------------------------------------------------------------------------

describe("checkAndFireHealthNudges — integration", () => {
  test("no errors, no timings → no nudges", async () => {
    await writeStats();
    const r = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(r.errorNudge).toBeNull();
    expect(r.regressionNudge).toBeNull();
  });

  test("3 current-session errors → error nudge with count=3 + first 2 visible", async () => {
    await writeStats();
    await writeJsonl("hook-errors.jsonl", [
      { ts: inSession(1000), hook: "posttooluse-genome", context: "scribe", error: "boom A" },
      { ts: inSession(2000), hook: "pretooluse-edit", context: "redirect", error: "boom B" },
      { ts: inSession(3000), hook: "session-end", context: "consolidate", error: "boom C" },
    ]);
    const r = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(r.errorNudge).not.toBeNull();
    expect(r.errorNudge).toContain("3 hook errors");
    expect(r.errorNudge).toContain("posttooluse-genome");
    expect(r.errorNudge).toContain("boom A");
    expect(r.errorNudge).toContain("pretooluse-edit");
    expect(r.errorNudge).toContain("boom B");
    expect(r.errorNudge).toContain("/ashlr-doctor --errors");
    expect(r.regressionNudge).toBeNull();
  });

  test("a malformed timing row cannot suppress an independent error nudge", async () => {
    await writeStats();
    await writeJsonl("hook-errors.jsonl", [
      { ts: inSession(1000), hook: "error-hook", context: "test", error: "visible failure" },
    ]);
    await writeFile(join(home, ".ashlr", "hook-timings.jsonl"), "null\n{broken\n");

    const result = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(result.errorNudge).toContain("visible failure");
    expect(result.regressionNudge).toBeNull();
  });

  test("errors from before session are filtered out", async () => {
    await writeStats();
    await writeJsonl("hook-errors.jsonl", [
      { ts: beforeSession(60_000), hook: "old-hook", context: "old", error: "ancient" },
    ]);
    const r = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(r.errorNudge).toBeNull();
  });

  test("hook with p95 = 500ms → regression nudge fires with hook name", async () => {
    await writeStats();
    // 10 timing rows for posttooluse-genome — 8 fast, 2 slow → p95 = 500.
    const rows: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push({
        ts: inSession(i * 100),
        hook: "posttooluse-genome",
        tool: null,
        durationMs: 10,
        outcome: "ok",
      });
    }
    for (let i = 0; i < 2; i++) {
      rows.push({
        ts: inSession(2000 + i * 100),
        hook: "posttooluse-genome",
        tool: null,
        durationMs: 500,
        outcome: "ok",
      });
    }
    await writeJsonl("hook-timings.jsonl", rows);
    const r = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(r.regressionNudge).not.toBeNull();
    expect(r.regressionNudge).toContain("posttooluse-genome");
    expect(r.regressionNudge).toContain("/ashlr-hook-timings --flags-only");
    expect(r.errorNudge).toBeNull();
  });

  test("uses retained timing rows when active has fewer than the cap", async () => {
    await writeStats();
    const retainedRows = Array.from({ length: 5 }, (_, i) => ({
      ts: inSession(i * 100),
      hook: "retained-slow-hook",
      tool: null,
      durationMs: 500,
      outcome: "ok",
    }));
    await writeFile(
      join(home, ".ashlr", "hook-timings.jsonl.1"),
      retainedRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    await writeJsonl("hook-timings.jsonl", [
      { ts: inSession(1_000), hook: "active-fast-hook", tool: null, durationMs: 5, outcome: "ok" },
    ]);

    const result = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(result.regressionNudge).toContain("retained-slow-hook");
  });

  test("both nudges fire independently in the same SessionEnd", async () => {
    await writeStats();
    await writeJsonl("hook-errors.jsonl", [
      { ts: inSession(1000), hook: "h-err", context: "x", error: "broken" },
    ]);
    await writeJsonl("hook-timings.jsonl", [
      { ts: inSession(500), hook: "h-slow", tool: null, durationMs: 1500, outcome: "ok" },
    ]);
    const r = checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    expect(r.errorNudge).not.toBeNull();
    expect(r.regressionNudge).not.toBeNull();
  });

  test("throttle: second SessionEnd within window does NOT re-fire either nudge", async () => {
    await writeStats();
    await writeJsonl("hook-errors.jsonl", [
      { ts: inSession(1000), hook: "h", context: "x", error: "E" },
    ]);
    await writeJsonl("hook-timings.jsonl", [
      { ts: inSession(500), hook: "slow", tool: null, durationMs: 1500, outcome: "ok" },
    ]);
    const now = sessionStartMs + 60_000;
    const first = checkAndFireHealthNudges(home, now);
    expect(first.errorNudge).not.toBeNull();
    expect(first.regressionNudge).not.toBeNull();

    // Second SessionEnd a few seconds later — both throttled.
    const second = checkAndFireHealthNudges(home, now + 5_000);
    expect(second.errorNudge).toBeNull();
    expect(second.regressionNudge).toBeNull();
  });

  test("scan completes well under the 2s hook safety net", async () => {
    await writeStats();
    // Realistic: ~2000 lines in each file. Even with cap=500 the file scan
    // dominates this; we assert the upper bound to lock in the safety budget.
    const errs: unknown[] = [];
    for (let i = 0; i < 2000; i++) {
      errs.push({
        ts: inSession(i),
        hook: "h",
        context: "c",
        error: `e${i}`,
      });
    }
    const timings: unknown[] = [];
    for (let i = 0; i < 2000; i++) {
      timings.push({
        ts: inSession(i),
        hook: "h",
        tool: null,
        durationMs: 5,
        outcome: "ok",
      });
    }
    await writeJsonl("hook-errors.jsonl", errs);
    await writeJsonl("hook-timings.jsonl", timings);

    const t0 = Date.now();
    checkAndFireHealthNudges(home, sessionStartMs + 60_000);
    const dt = Date.now() - t0;
    // Comfortable margin against the 2s hook safety net.
    expect(dt).toBeLessThan(500);
  });
});
