/**
 * telemetry-track1.test.ts — v1.30 Track 1 client-side tests.
 *
 * Coverage:
 *   - New client-side event kinds round-trip through the JSONL buffer.
 *   - tool_call with tool_name serializes correctly.
 *   - logHookPerfEvent / logGenomeCompressionRatioEvent convenience wrappers.
 *   - computeHookPerfSummaries computes p50/p99 from synthetic timings data.
 *   - emitHookPerfEvents is a no-op when telemetry is off.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  recordTelemetryEvent,
  readTelemetryBuffer,
  logHookPerfEvent,
  logGenomeCompressionRatioEvent,
} from "../servers/_telemetry";
import { computeHookPerfSummaries, emitHookPerfEvents } from "../hooks/_hook-perf-emit";
import { readConversionRatio } from "../scripts/telemetry-status";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let home: string;
let origHome: string | undefined;
let origTelemetry: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-t1-test-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  origHome = process.env.HOME;
  origTelemetry = process.env.ASHLR_TELEMETRY;
  process.env.HOME = home;
  process.env.ASHLR_TELEMETRY = "on";
});

afterEach(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origTelemetry !== undefined) process.env.ASHLR_TELEMETRY = origTelemetry;
  else delete process.env.ASHLR_TELEMETRY;
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1.1 — tool_call with tool_name
// ---------------------------------------------------------------------------

describe("1.1 — tool_call with tool_name", () => {
  test("tool_call with tool_name serializes into buffer", () => {
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__grep",
      tool_name: "ashlr__grep",
      rawBytes: 8000,
      compactBytes: 900,
      fellBack: false,
      providerUsed: "local",
      durationMs: 50,
    }, home);

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("tool_call");
    expect(records[0]!.tool_name).toBe("ashlr__grep");
  });

  test("tool_call without tool_name still accepted (backward compat)", () => {
    recordTelemetryEvent({
      kind: "tool_call",
      tool: "ashlr__read",
      rawBytes: 5000,
      compactBytes: 600,
      fellBack: false,
      providerUsed: "local",
      durationMs: 30,
    }, home);

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.tool_name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1.2 — hook_perf convenience wrapper
// ---------------------------------------------------------------------------

describe("1.2 — logHookPerfEvent", () => {
  test("writes hook_perf event with correct fields", () => {
    logHookPerfEvent({
      hook_name: "pretooluse-grep",
      p50_ms: 12,
      p99_ms: 45,
      count: 38,
    }, home);

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("hook_perf");
    expect(records[0]!.hook_name).toBe("pretooluse-grep");
    expect(records[0]!.p50_ms).toBe(12);
    expect(records[0]!.p99_ms).toBe(45);
    expect(records[0]!.count).toBe(38);
  });

  test("no-op when telemetry is off", () => {
    process.env.ASHLR_TELEMETRY = "off";
    logHookPerfEvent({ hook_name: "pretooluse-grep", p50_ms: 10, p99_ms: 30, count: 5 }, home);
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1.3 — genome_compression_ratio convenience wrapper
// ---------------------------------------------------------------------------

describe("1.3 — logGenomeCompressionRatioEvent", () => {
  test("writes genome_compression_ratio event with correct fields", () => {
    logGenomeCompressionRatioEvent({
      tool: "ashlr__grep",
      raw_bytes: 48000,
      compressed_bytes: 3200,
    }, home);

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("genome_compression_ratio");
    expect(records[0]!.tool).toBe("ashlr__grep");
    expect(records[0]!.raw_bytes).toBe(48000);
    expect(records[0]!.compressed_bytes).toBe(3200);
  });
});

// ---------------------------------------------------------------------------
// 1.2 — computeHookPerfSummaries + emitHookPerfEvents
// ---------------------------------------------------------------------------

describe("computeHookPerfSummaries", () => {
  test("returns empty array when no timings file", () => {
    const summaries = computeHookPerfSummaries({ timingsPath: join(home, "nonexistent.jsonl") });
    expect(summaries).toEqual([]);
  });

  test("computes p50 and p99 from synthetic timings data", async () => {
    // Write a synthetic hook-timings.jsonl
    const lines: string[] = [];
    const now = new Date().toISOString();
    // 10 records for pretooluse-grep: durations 10..100ms (step 10)
    for (let i = 1; i <= 10; i++) {
      lines.push(JSON.stringify({ ts: now, hook: "pretooluse-grep", tool: null, durationMs: i * 10, outcome: "ok" }));
    }
    // 2 records for session-end: 200ms, 300ms
    lines.push(JSON.stringify({ ts: now, hook: "session-end", tool: null, durationMs: 200, outcome: "ok" }));
    lines.push(JSON.stringify({ ts: now, hook: "session-end", tool: null, durationMs: 300, outcome: "ok" }));

    const timingsPath = join(home, "hook-timings.jsonl");
    await writeFile(timingsPath, lines.join("\n") + "\n");

    const summaries = computeHookPerfSummaries({ timingsPath });

    const grep = summaries.find((s) => s.hook_name === "pretooluse-grep");
    expect(grep).toBeTruthy();
    expect(grep!.count).toBe(10);
    // sorted: 10,20,30,40,50,60,70,80,90,100 — p50 = 55 (avg of idx4+5), p99 ≈ 100
    expect(grep!.p50_ms).toBeGreaterThanOrEqual(50);
    expect(grep!.p50_ms).toBeLessThanOrEqual(60);
    expect(grep!.p99_ms).toBeGreaterThanOrEqual(90);

    const se = summaries.find((s) => s.hook_name === "session-end");
    expect(se).toBeTruthy();
    expect(se!.count).toBe(2);
    expect(se!.p50_ms).toBeGreaterThanOrEqual(200);
    expect(se!.p99_ms).toBeGreaterThanOrEqual(290);
  });

  test("emitHookPerfEvents is no-op when telemetry off", async () => {
    process.env.ASHLR_TELEMETRY = "off";
    const n = emitHookPerfEvents({ homeDir: home });
    expect(n).toBe(0);
    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(0);
  });

  test("emitHookPerfEvents writes events to buffer when telemetry on", async () => {
    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), hook: "pretooluse-bash", tool: null, durationMs: 15, outcome: "ok" }),
      JSON.stringify({ ts: new Date().toISOString(), hook: "pretooluse-bash", tool: null, durationMs: 25, outcome: "ok" }),
    ];
    const timingsPath = join(home, "hook-timings.jsonl");
    await writeFile(timingsPath, lines.join("\n") + "\n");

    const n = emitHookPerfEvents({ timingsPath, homeDir: home });
    expect(n).toBe(1); // one hook: pretooluse-bash

    const records = readTelemetryBuffer(home);
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("hook_perf");
    expect(records[0]!.hook_name).toBe("pretooluse-bash");
    expect(records[0]!.count).toBe(2);
  });
});

describe("telemetry conversion coverage", () => {
  test("does not report an exact percentage from partial timing coverage", async () => {
    const now = new Date().toISOString();
    await writeFile(
      join(home, ".ashlr", "hook-timings.jsonl"),
      JSON.stringify({ ts: now, hook: "h", durationMs: 1, outcome: "block" }) + "\n",
    );
    await writeFile(join(home, ".ashlr", "hook-timings.jsonl.meta.json"), JSON.stringify({
      schemaVersion: 1,
      droppedThrough: null,
      updatedAt: now,
    }));

    const output = readConversionRatio(home);
    expect(output).toContain("unavailable");
    expect(output).toContain("partial hook-timing coverage");
    expect(output).not.toMatch(/\d+%/);
  });
});
