#!/usr/bin/env bun
/**
 * demo-run.ts — 30-second scripted showcase of ashlr token savings.
 *
 * Usage:
 *   bun run scripts/demo-run.ts [--cwd <dir>]
 *
 * Behavior:
 *   1. Finds a largish source file (>2KB) in the target directory.
 *   2. Reads it via snipCompact (same path as ashlr__read) — reports bytes.
 *   3. Greps for a common pattern — reports bytes.
 *   4. Shows totals + projected lifetime savings from ~/.ashlr/stats.json.
 *
 * Contract:
 *   - Exits 0 always.
 *   - Never writes files.
 *   - Output <= 30 lines, plain text, width <= 80.
 *   - Safe to run repeatedly.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, extname, relative } from "path";
import { spawnSync } from "child_process";

import { snipCompact, type Message } from "@ashlr/core-efficiency";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function print(s: string): void {
  process.stdout.write(s + "\n");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pct(saved: number, original: number): string {
  if (original <= 0) return "0%";
  return `${Math.round((saved / original) * 100)}%`;
}

/** Walk directory up to maxDepth, collect files matching predicate. */
function walkFiles(
  dir: string,
  pred: (p: string) => boolean,
  maxDepth = 3,
): string[] {
  const results: string[] = [];
  function walk(d: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (pred(full)) {
        results.push(full);
      }
    }
  }
  walk(dir, 0);
  return results;
}

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".rb", ".c", ".cpp", ".h", ".cs", ".swift", ".kt",
]);

/** Find the largest source file > 2KB, up to 500KB. */
function findDemoFile(cwd: string): string | null {
  const candidates = walkFiles(cwd, (p) => SOURCE_EXTS.has(extname(p)));
  const sized = candidates
    .map((p) => ({ p, size: statSync(p).size }))
    .filter(({ size }) => size > 2048 && size < 500 * 1024)
    .sort((a, b) => b.size - a.size);
  return sized[0]?.p ?? null;
}

/** Apply snipCompact exactly as ashlr__read does (without summarization). */
function compactRead(content: string): string {
  const msgs: Message[] = [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "demo-read", content }],
    },
  ];
  const compact = snipCompact(msgs);
  const block = (compact[0]!.content as { type: string; content: string }[])[0]!;
  return (block as { content: string }).content;
}

/** Run ripgrep and return raw output bytes + truncated text. */
function runGrep(pattern: string, cwd: string): { rawBytes: number; outBytes: number } {
  // Resolve rg binary (mirrors efficiency-server logic).
  const rgBin =
    (typeof (globalThis as { Bun?: { which(b: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(b: string): string | null } }).Bun.which("rg")
      : null) ??
    ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find((p) => {
      try { require("fs").accessSync(p); return true; } catch { return false; }
    }) ??
    "rg";

  const res = spawnSync(rgBin, ["--json", "-n", pattern, cwd], {
    encoding: "utf-8",
    timeout: 8_000,
  });
  const raw = res.stdout ?? "";
  const truncated =
    raw.length > 4000 ? raw.slice(0, 2000) + "\n\n[...truncated...]\n\n" + raw.slice(-1000) : raw;
  return { rawBytes: raw.length, outBytes: truncated.length };
}

/** Read lifetime stats for projection. */
function readLifetimeStats(): { calls: number; tokensSaved: number } {
  // Prefer $HOME when explicitly set so tests (and container/shell overrides)
  // work uniformly on Windows, where `homedir()` reads USERPROFILE instead.
  const home = process.env.HOME ?? homedir();
  const p = join(home, ".ashlr", "stats.json");
  if (!existsSync(p)) return { calls: 0, tokensSaved: 0 };
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as {
      lifetime?: { calls?: number; tokensSaved?: number };
    };
    return {
      calls: data.lifetime?.calls ?? 0,
      tokensSaved: data.lifetime?.tokensSaved ?? 0,
    };
  } catch {
    return { calls: 0, tokensSaved: 0 };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // Parse --cwd arg
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  const cwdIdx = args.indexOf("--cwd");
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    cwd = args[cwdIdx + 1]!;
  }

  const lines: string[] = [];

  lines.push("ashlr 30-second demo");
  lines.push("=".repeat(40));
  lines.push(`project: ${cwd}`);
  lines.push("");

  // Step 1: find a source file
  const demoFile = findDemoFile(cwd);
  if (!demoFile) {
    lines.push("no suitable source file found (need >2KB source file)");
    lines.push("tip: run from a project directory with source code.");
    lines.forEach(print);
    process.exit(0);
  }

  const relPath = relative(cwd, demoFile);
  const rawContent = readFileSync(demoFile, "utf-8");
  const rawBytes = Buffer.byteLength(rawContent, "utf-8");

  // Step 2: ashlr__read (snipCompact)
  const compacted = compactRead(rawContent);
  const compactBytes = Buffer.byteLength(compacted, "utf-8");
  const readSaved = Math.max(0, rawBytes - compactBytes);
  const readTokSaved = Math.ceil(readSaved / 4);

  lines.push(`[1] ashlr__read  ${relPath}`);
  lines.push(`    original : ${fmtBytes(rawBytes)}`);
  lines.push(`    compacted: ${fmtBytes(compactBytes)}  (${pct(readSaved, rawBytes)} smaller)`);
  lines.push(`    tokens saved: ~${readTokSaved.toLocaleString()}`);
  lines.push("");

  // Step 3: ashlr__grep
  const pattern = "import|function";
  const { rawBytes: grepRaw, outBytes: grepOut } = runGrep(pattern, cwd);
  const grepSaved = Math.max(0, grepRaw - grepOut);
  const grepTokSaved = Math.ceil(grepSaved / 4);

  lines.push(`[2] ashlr__grep  pattern: "${pattern}"`);
  if (grepRaw === 0) {
    lines.push(`    ripgrep not available — skipping grep demo`);
  } else {
    lines.push(`    raw rg output : ${fmtBytes(grepRaw)}`);
    lines.push(`    truncated to  : ${fmtBytes(grepOut)}  (${pct(grepSaved, grepRaw)} smaller)`);
    lines.push(`    tokens saved: ~${grepTokSaved.toLocaleString()}`);
  }
  lines.push("");

  // Step 4: totals + projection
  const demoTokSaved = readTokSaved + grepTokSaved;
  const lifetime = readLifetimeStats();
  const lifetimeTokSaved = lifetime.tokensSaved + demoTokSaved;

  // Rough projection: extrapolate from lifetime average calls-per-day
  // Assume ~5 working days/week, 50 weeks/year = 250 days.
  const COST_PER_M_TOK = 3.0; // sonnet-4.5 input
  const lifetimeCost = (lifetimeTokSaved * COST_PER_M_TOK) / 1_000_000;

  lines.push(`[3] totals`);
  lines.push(`    this demo saved: ~${demoTokSaved.toLocaleString()} tokens`);
  lines.push(
    `    lifetime total : ~${lifetimeTokSaved.toLocaleString()} tokens` +
      `  (≈ $${lifetimeCost.toFixed(2)})`,
  );

  if (lifetime.calls >= 10) {
    // Enough data to project: average tok/call, assume 50 calls/day typical session.
    const avgTokPerCall = lifetime.tokensSaved / lifetime.calls;
    const projectedAnnualTok = avgTokPerCall * 50 * 250;
    const projectedAnnualCost = (projectedAnnualTok * COST_PER_M_TOK) / 1_000_000;
    lines.push(
      `    projected annual: ~${Math.round(projectedAnnualTok / 1000)}K tokens` +
        `  ≈ $${projectedAnnualCost.toFixed(0)}/yr`,
    );
  }

  lines.push("");
  lines.push("install: https://plugin.ashlr.ai");

  // Trim to 30 lines
  const out = lines.slice(0, 30);
  out.forEach(print);
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(`demo-run error: ${msg}\n`);
}
process.exit(0);
