/**
 * Router cold-start latency test.
 *
 * Spawns `servers/_router.ts` as a real MCP stdio process, times how long
 * the initialize handshake takes, and asserts it completes under 100ms.
 *
 * The 100ms target reflects:
 *   - Bun startup + module evaluation + handler registration: ~40-60ms
 *   - MCP handshake (stdio round-trip): ~5-10ms
 *   - Headroom: ~30-40ms
 *
 * Measured baseline on 2026-04-25 MacBook M-series: ~75ms p95 with all
 * 40 handlers registered. The old per-server architecture started N
 * child processes sequentially (200-400ms aggregate).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { timingBudgetMs } from "../scripts/timing-budget.ts";

const ROUTER = resolve(__dirname, "..", "servers", "_router.ts");
// Median cold-start assertion target. Engineering goal is <100ms on a warmed
// standalone run (measured ~91ms median, ~115ms p95 over 10 standalone runs).
// Under `bun test`, a parent bun process is already running so child bun
// spawns contend for CPU — adds ~50-100ms of scheduling overhead. 300ms is
// the bound that catches genuine regressions (a regressed router would take
// 500ms+ per run) while remaining stable across POSIX CI.
//
// Windows hosted runners are virtualized + antivirus-scanned, which can push
// child bun spawn well past 1s without any real regression. We use a separate,
// looser bound there (still well under "regressed router" levels) so the
// assertion catches actual perf regressions without flaking on slow VMs.
//
// On CI (macOS in particular) the POSIX bound is scaled by timingBudgetMs; a
// local run still asserts the original 300ms.
const TARGET_MEDIAN_MS = process.platform === "win32" ? 1500 : timingBudgetMs(300);

// Why POSIX asserts on CPU time: wall-clock cold start is mostly CPU-bound
// module evaluation, so it stretches with whatever else the host is running.
// Measured on an 8-core Linux box: idle, wall 112-142ms and child CPU
// 179-190ms; with 24 busy loops, wall 341-453ms but child CPU 162-199ms.
// The wall bound failed under load with no code change; child CPU time
// (user + sys) did not move. So POSIX asserts the median child CPU time
// against the same budget, and keeps a loose wall bound (5x) that still
// catches a hang or a sleep, which CPU time would not show.
const POSIX_WALL_CEILING_MS = TARGET_MEDIAN_MS * 5;

interface ColdStartSample {
  wallMs: number;
  cpuMs: number | null;
}

const INIT_REQUEST =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cold-start-test", version: "1" },
    },
  }) + "\n";

/**
 * Spawn the router, send an initialize request, and return elapsed ms from
 * spawn() call to receipt of the initialize response.
 */
async function measureColdStart(home: string): Promise<ColdStartSample> {
  const t0 = performance.now();

  const proc = spawn({
    cmd: ["bun", "run", ROUTER],
    cwd: resolve(__dirname, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: home,
      ASHLR_STATS_SYNC: "1",
      ASHLR_SESSION_LOG: "0",
    },
  });

  proc.stdin.write(INIT_REQUEST);
  await proc.stdin.end();

  // Drain stdout line-by-line until we see the initialize response.
  const text = await new Response(proc.stdout).text();
  const elapsed = performance.now() - t0;

  await proc.exited;

  // Verify we actually got a valid response (not just a timeout or error).
  const lines = text.split("\n").filter((l) => l.trim());
  const initLine = lines.find((l) => {
    try {
      const msg = JSON.parse(l);
      return msg?.result?.serverInfo?.name === "ashlr-router";
    } catch {
      return false;
    }
  });

  if (!initLine) {
    throw new Error(
      `Router did not emit a valid initialize response.\nStdout:\n${text.slice(0, 500)}`,
    );
  }

  const usage = proc.resourceUsage();
  const cpuMs = usage
    ? (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000
    : null;
  return { wallMs: elapsed, cpuMs };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-coldstart-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("router · cold-start latency", () => {
  test(`median cold-start < ${TARGET_MEDIAN_MS}ms (3 samples)`, async () => {
    // Take 3 samples and assert on the median. A single measurement is noisy
    // due to OS scheduling spikes; median over 3 is stable while still
    // catching genuine regressions (a regressed router takes 300ms+ per run).
    const samples: ColdStartSample[] = [];
    for (let i = 0; i < 3; i++) {
      samples.push(await measureColdStart(home));
    }
    const wall = median(samples.map((s) => s.wallMs));
    const cpuValues = samples.map((s) => s.cpuMs).filter((v): v is number => v !== null);
    const cpu = cpuValues.length === samples.length ? median(cpuValues) : null;
    process.stderr.write(
      `[cold-start-test] wall: ${samples.map((s) => s.wallMs.toFixed(1)).join("ms, ")}ms (median ${wall.toFixed(1)}ms) · ` +
        `cpu median ${cpu === null ? "n/a" : cpu.toFixed(1) + "ms"} (target: <${TARGET_MEDIAN_MS}ms)\n`,
    );
    if (process.platform === "win32" || cpu === null) {
      expect(wall).toBeLessThan(TARGET_MEDIAN_MS);
    } else {
      expect(cpu).toBeLessThan(TARGET_MEDIAN_MS);
      expect(wall).toBeLessThan(POSIX_WALL_CEILING_MS);
    }
  }, 30_000 /* 3 spawns; generous timeout so the assertion is the meaningful signal */);

  test("router registers the startup tool-count log line to stderr", async () => {
    const proc = spawn({
      cmd: ["bun", "run", ROUTER],
      cwd: resolve(__dirname, ".."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_STATS_SYNC: "1",
        ASHLR_SESSION_LOG: "0",
      },
    });

    proc.stdin.write(INIT_REQUEST);
    await proc.stdin.end();

    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    // The startup log includes tool count and version.
    expect(stderr).toMatch(/\[ashlr-router\] starting · \d+ tools registered/);
  }, 10_000);
});
