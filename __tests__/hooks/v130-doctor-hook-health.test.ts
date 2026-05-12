/**
 * v1.30 #7 — getDoctorHookHealth tests.
 *
 * Verifies the new hook-performance surface in /ashlr-doctor correctly
 * classifies hooks as ok/warn/fail based on p95 latency, error rate, and
 * the v1.29 "timeout" outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getDoctorHookHealth } from "../../scripts/hook-timings-report";

function tmpTimingsPath(): string {
  const dir = join(tmpdir(), `ashlr-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "hook-timings.jsonl");
}

function writeTimings(
  path: string,
  records: Array<{
    hook: string;
    durationMs: number;
    outcome: "ok" | "bypass" | "block" | "error" | "timeout";
    tool?: string | null;
    minutesAgo?: number;
  }>,
): void {
  const lines = records.map((r) => {
    const ts = new Date(Date.now() - (r.minutesAgo ?? 0) * 60_000).toISOString();
    return JSON.stringify({
      ts,
      hook: r.hook,
      tool: r.tool ?? null,
      durationMs: r.durationMs,
      outcome: r.outcome,
    });
  });
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}

let timingsPath: string;
beforeEach(() => { timingsPath = tmpTimingsPath(); });
afterEach(() => {
  try { rmSync(timingsPath, { force: true }); } catch { /* */ }
});

describe("getDoctorHookHealth", () => {
  test("returns empty findings when no records exist", () => {
    const result = getDoctorHookHealth({ path: timingsPath });
    expect(result.totalCalls).toBe(0);
    expect(result.findings).toEqual([]);
  });

  test("classifies hooks under 50ms p95 as ok (top 3 returned)", () => {
    writeTimings(timingsPath, [
      { hook: "pretooluse-read", durationMs: 10, outcome: "ok" },
      { hook: "pretooluse-read", durationMs: 12, outcome: "ok" },
      { hook: "pretooluse-grep", durationMs: 15, outcome: "ok" },
    ]);
    const { findings, totalCalls } = getDoctorHookHealth({ path: timingsPath });
    expect(totalCalls).toBe(3);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.status === "ok")).toBe(true);
  });

  test("flags hooks with p95 ≥ 50ms as warn", () => {
    writeTimings(timingsPath, [
      // Two slow records → p95 lands at 80ms.
      { hook: "pretooluse-read", durationMs: 70, outcome: "ok" },
      { hook: "pretooluse-read", durationMs: 80, outcome: "ok" },
    ]);
    const { findings } = getDoctorHookHealth({ path: timingsPath });
    const found = findings.find((f) => f.label === "pretooluse-read");
    expect(found?.status).toBe("warn");
  });

  test("flags hooks with p95 ≥ 200ms as fail", () => {
    writeTimings(timingsPath, [
      { hook: "pretooluse-read", durationMs: 250, outcome: "ok" },
      { hook: "pretooluse-read", durationMs: 300, outcome: "ok" },
    ]);
    const { findings } = getDoctorHookHealth({ path: timingsPath });
    const found = findings.find((f) => f.label === "pretooluse-read");
    expect(found?.status).toBe("fail");
  });

  test("ANY timeout occurrence flags the hook as fail (even when p95 is low)", () => {
    writeTimings(timingsPath, [
      { hook: "pretooluse-read", durationMs: 5, outcome: "ok" },
      { hook: "pretooluse-read", durationMs: 5, outcome: "ok" },
      { hook: "pretooluse-read", durationMs: 2000, outcome: "timeout" },
    ]);
    const { findings } = getDoctorHookHealth({ path: timingsPath });
    const found = findings.find((f) => f.label === "pretooluse-read");
    expect(found?.status).toBe("fail");
    expect(found?.detail).toContain("timeout");
    expect(found?.fix).toContain("safety net");
  });

  test("error rate > 5% flags as fail", () => {
    // 1 error in 5 calls = 20% error rate, well above 5% threshold.
    writeTimings(timingsPath, [
      { hook: "policy-enforce", durationMs: 30, outcome: "ok" },
      { hook: "policy-enforce", durationMs: 30, outcome: "ok" },
      { hook: "policy-enforce", durationMs: 30, outcome: "ok" },
      { hook: "policy-enforce", durationMs: 30, outcome: "ok" },
      { hook: "policy-enforce", durationMs: 30, outcome: "error" },
    ]);
    const { findings } = getDoctorHookHealth({ path: timingsPath });
    const found = findings.find((f) => f.label === "policy-enforce");
    expect(found?.status).toBe("fail");
    expect(found?.detail).toContain("error");
    expect(found?.fix).toContain("hook-errors.jsonl");
  });

  test("respects custom warnP95Ms and failP95Ms thresholds", () => {
    writeTimings(timingsPath, [
      { hook: "pretooluse-read", durationMs: 60, outcome: "ok" },
      { hook: "pretooluse-read", durationMs: 60, outcome: "ok" },
    ]);
    // Tight thresholds: 25 / 50.
    const { findings } = getDoctorHookHealth({
      path: timingsPath,
      warnP95Ms: 25,
      failP95Ms: 50,
    });
    const found = findings.find((f) => f.label === "pretooluse-read");
    expect(found?.status).toBe("fail");
  });

  test("filters records by window (hours) — old records excluded", () => {
    writeTimings(timingsPath, [
      { hook: "pretooluse-read", durationMs: 5, outcome: "ok", minutesAgo: 0 },
      // 25h old — outside the default 24h window.
      { hook: "pretooluse-grep", durationMs: 999, outcome: "ok", minutesAgo: 25 * 60 },
    ]);
    const { findings, totalCalls } = getDoctorHookHealth({ path: timingsPath, hours: 24 });
    expect(totalCalls).toBe(1);
    // Old slow record shouldn't show up
    expect(findings.find((f) => f.label === "pretooluse-grep")).toBeUndefined();
  });

  test("worst offenders come first in findings", () => {
    writeTimings(timingsPath, [
      { hook: "fast-hook", durationMs: 10, outcome: "ok" },
      { hook: "slow-hook", durationMs: 300, outcome: "ok" },
      { hook: "slow-hook", durationMs: 300, outcome: "ok" },
      { hook: "broken-hook", durationMs: 2000, outcome: "timeout" },
    ]);
    const { findings } = getDoctorHookHealth({ path: timingsPath });
    // First finding should be the failing one (timeout > fail-p95 > warn > ok).
    expect(findings[0]?.label).toBe("broken-hook");
    expect(findings[0]?.status).toBe("fail");
  });
});
