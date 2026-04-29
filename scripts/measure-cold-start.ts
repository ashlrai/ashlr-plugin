#!/usr/bin/env bun
/**
 * measure-cold-start — time how long the ashlr-router takes from process
 * launch to a valid `initialize` response over stdio.
 *
 * Usage:
 *   bun run scripts/measure-cold-start.ts              # single run, prints ms
 *   bun run scripts/measure-cold-start.ts --runs 5     # average of N runs
 *   bun run scripts/measure-cold-start.ts --assert     # exit 1 if p95 >= 100ms
 *
 * The measurement starts at spawn() and ends when the first valid JSON line
 * appears on stdout (the initialize response). This captures the full
 * cold-start path: Bun startup + module evaluation + handler registration +
 * MCP stdio handshake.
 */

import { spawn } from "bun";
import { resolve } from "path";

const ROUTER = resolve(import.meta.dir, "..", "servers", "_router.ts");

const INIT_REQUEST =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cold-start-measure", version: "1" },
    },
  }) + "\n";

/** Measure one cold-start. Returns elapsed milliseconds. */
async function measureOnce(): Promise<number> {
  const t0 = performance.now();

  const proc = spawn({
    cmd: ["bun", "run", ROUTER],
    cwd: resolve(import.meta.dir, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ASHLR_STATS_SYNC: "1",
      ASHLR_SESSION_LOG: "0",
    },
  });

  proc.stdin.write(INIT_REQUEST);
  await proc.stdin.end();

  // Read lines until we get the initialize response.
  const reader = proc.stdout.getReader();
  let buf = "";
  let elapsed = -1;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg?.result?.serverInfo?.name === "ashlr-router") {
          elapsed = performance.now() - t0;
          break outer;
        }
      } catch {
        // not JSON yet — keep reading
      }
    }
  }

  reader.cancel();
  await proc.exited;

  if (elapsed < 0) throw new Error("Router did not emit an initialize response");
  return elapsed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const runsArg = args.indexOf("--runs");
const runs = runsArg >= 0 ? parseInt(args[runsArg + 1] ?? "5", 10) : 1;
const shouldAssert = args.includes("--assert");
const TARGET_MS = 100;

const samples: number[] = [];
for (let i = 0; i < runs; i++) {
  const ms = await measureOnce();
  samples.push(ms);
  process.stdout.write(`  run ${i + 1}/${runs}: ${ms.toFixed(1)}ms\n`);
}

samples.sort((a, b) => a - b);
const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
const p50 = samples[Math.floor(samples.length * 0.5)]!;
const p95 = samples[Math.floor(samples.length * 0.95)]!;
const max = samples[samples.length - 1]!;

process.stdout.write(
  `\nashlr-router cold-start (${runs} run${runs === 1 ? "" : "s"})\n` +
    `  avg  ${avg.toFixed(1)}ms\n` +
    `  p50  ${p50.toFixed(1)}ms\n` +
    `  p95  ${p95.toFixed(1)}ms\n` +
    `  max  ${max.toFixed(1)}ms\n` +
    `  target: < ${TARGET_MS}ms\n`,
);

if (shouldAssert) {
  if (p95 >= TARGET_MS) {
    process.stderr.write(
      `[measure-cold-start] FAIL: p95=${p95.toFixed(1)}ms >= ${TARGET_MS}ms target\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`[measure-cold-start] PASS: p95=${p95.toFixed(1)}ms < ${TARGET_MS}ms\n`);
}
