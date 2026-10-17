#!/usr/bin/env bun
/**
 * scripts/bench-read-real.ts
 *
 * Measures the real ashlrRead handler (line numbering, snip, badge included)
 * against raw file tokens, bucketed by file size. run-benchmark.ts mirrors only
 * snipCompact, so it cannot see per-line overhead on small files.
 *
 *   bun run scripts/bench-read-real.ts [--every N]   # every Nth tracked text file (default 3)
 *
 * Synthetic: token counts come from estimateTokensFromString, not a real tokenizer.
 * Same-commit comparison: run it before and after a change on the same file list.
 */
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { ashlrRead } from "../servers/read-server.ts";
import { estimateTokensFromString } from "@ashlr/core-efficiency";

const every = Number(process.argv[process.argv.indexOf("--every") + 1]) || 3;
const files = execSync(
  "git ls-files -- '*.ts' '*.md' '*.json' '*.sh' '*.tsx' | grep -v -E 'bun.lock|^bench/refs|^video|^site|^scripts/bench-read-real'",
  { encoding: "utf-8", maxBuffer: 1e8 },
).trim().split("\n");
const bucket = (n: number) => n < 1000 ? "a <1K" : n < 1700 ? "b 1-1.7K" : n < 2500 ? "c 1.7-2.5K" : n < 5000 ? "d 2.5-5K" : n < 15000 ? "e 5-15K" : "f 15K+";
const b: Record<string, { n: number; r: number; a: number; worse: number }> = {};
let tr = 0, ta = 0, k = 0;
for (const f of files) {
  let raw: string;
  try { raw = readFileSync(f, "utf-8"); } catch { continue; }
  if (!raw.length || raw.length > 400000) continue;
  if (k++ % every) continue;
  let out: string;
  try { out = await ashlrRead({ path: f }); } catch { continue; }
  const r = estimateTokensFromString(raw), a = estimateTokensFromString(out);
  tr += r; ta += a;
  const x = (b[bucket(raw.length)] ??= { n: 0, r: 0, a: 0, worse: 0 });
  x.n++; x.r += r; x.a += a; if (a > r) x.worse++;
}
for (const key of Object.keys(b).sort()) {
  const v = b[key]!;
  console.log(key.slice(2).padEnd(10), "files", String(v.n).padStart(4), "raw", String(v.r).padStart(7), "ashlr", String(v.a).padStart(7), ((v.a / v.r - 1) * 100).toFixed(1).padStart(6) + "%", "worse-than-raw", v.worse);
}
console.log("TOTAL".padEnd(10), "raw", tr, "ashlr", ta, ((ta / tr - 1) * 100).toFixed(1) + "%");
