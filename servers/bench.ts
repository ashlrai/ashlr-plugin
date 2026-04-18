#!/usr/bin/env bun
/**
 * Benchmark harness: ashlr__read vs native fs.readFile.
 *
 * Measures token savings on real files using chars/4 heuristic (same
 * estimator the plugin uses at runtime). Output is tabular so it can be
 * pasted into the README / landing page.
 *
 * Usage:
 *   bun run servers/bench.ts                     # auto-discover 6 files
 *   bun run servers/bench.ts --path src/x.ts     # one explicit file
 *   bun run servers/bench.ts --path p --json     # machine-readable
 *
 * Also supports directory scanning:
 *   bun run servers/bench.ts --dir ../ashlrcode/src/agent
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, resolve, relative } from "path";

import {
  estimateTokensFromString,
  snipCompact,
  type Message,
} from "@ashlr/core-efficiency";

interface Row {
  path: string;
  loc: number;
  rawChars: number;
  rawTokens: number;
  compactChars: number;
  compactTokens: number;
  savedPct: number;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): { path?: string; dir?: string; json: boolean } {
  const args = process.argv.slice(2);
  const out: { path?: string; dir?: string; json: boolean } = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path") out.path = args[++i];
    else if (a === "--dir") out.dir = args[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single-file bench
// ---------------------------------------------------------------------------

async function benchFile(path: string): Promise<Row> {
  const abs = resolve(path);
  const content = await readFile(abs, "utf-8");

  const msgs: Message[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "bench", content },
      ],
    },
  ];

  const compact = snipCompact(msgs);
  const block = (compact[0]!.content as { type: string; content: string }[])[0]!;
  const out = (block as { content: string }).content;

  const rawChars = content.length;
  const compactChars = out.length;
  const rawTokens = estimateTokensFromString(content);
  const compactTokens = estimateTokensFromString(out);
  const savedPct = rawTokens === 0 ? 0 : (1 - compactTokens / rawTokens) * 100;

  return {
    path: abs,
    loc: content.split("\n").length,
    rawChars,
    rawTokens,
    compactChars,
    compactTokens,
    savedPct,
  };
}

// ---------------------------------------------------------------------------
// Auto-discovery: walk a dir for .ts/.tsx files, take top-N by size
// ---------------------------------------------------------------------------

async function walkDir(dir: string, max = 6): Promise<string[]> {
  const out: { path: string; size: number }[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) {
        const s = await stat(p);
        if (s.size > 500) out.push({ path: p, size: s.size });
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => b.size - a.size).slice(0, max).map((x) => x.path);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(rows: Row[]) {
  const pad = (s: string, n: number) => s.padEnd(n);
  const padR = (s: string, n: number) => s.padStart(n);

  console.log("");
  console.log(pad("FILE", 48) + padR("LOC", 7) + padR("RAW TOK", 10) + padR("ASHLR TOK", 12) + padR("SAVED", 9));
  console.log("─".repeat(86));
  for (const r of rows) {
    const rel = relative(process.cwd(), r.path);
    const name = rel.length > 46 ? "…" + rel.slice(-45) : rel;
    const savedStr = r.savedPct >= 1
      ? `−${r.savedPct.toFixed(1)}%`
      : `  ${r.savedPct.toFixed(1)}%`;
    console.log(
      pad(name, 48) +
        padR(r.loc.toString(), 7) +
        padR(r.rawTokens.toLocaleString(), 10) +
        padR(r.compactTokens.toLocaleString(), 12) +
        padR(savedStr, 9),
    );
  }
  console.log("─".repeat(86));
  const rawTotal = rows.reduce((s, r) => s + r.rawTokens, 0);
  const compactTotal = rows.reduce((s, r) => s + r.compactTokens, 0);
  const overall = rawTotal === 0 ? 0 : (1 - compactTotal / rawTotal) * 100;
  console.log(
    pad(`TOTAL · ${rows.length} files`, 48) +
      padR("", 7) +
      padR(rawTotal.toLocaleString(), 10) +
      padR(compactTotal.toLocaleString(), 12) +
      padR(`−${overall.toFixed(1)}%`, 9),
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs();

let paths: string[] = [];
if (opts.path) paths = [opts.path];
else if (opts.dir) paths = await walkDir(opts.dir);
else {
  // Default: bench 6 representative files from the sibling ashlr-core-efficiency
  const fallback = resolve(process.cwd(), "../ashlr-core-efficiency/src");
  paths = await walkDir(fallback);
}

if (paths.length === 0) {
  console.error("No files found to benchmark. Pass --path or --dir.");
  process.exit(1);
}

const rows: Row[] = [];
for (const p of paths) {
  try {
    rows.push(await benchFile(p));
  } catch (err) {
    console.error(`skip ${p}:`, err instanceof Error ? err.message : err);
  }
}

if (opts.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log("\nashlr__read benchmark · chars/4 token heuristic · snipCompact applied\n");
  printTable(rows);
}
