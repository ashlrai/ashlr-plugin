#!/usr/bin/env bun
/**
 * ashlr-efficiency MCP server.
 *
 * Exposes token-efficient replacements for Claude Code's built-in file tools:
 *   - ashlr__read  — snipCompact on file contents > 2KB
 *   - ashlr__grep  — genome-aware retrieval when .ashlrcode/genome/ exists,
 *                    ripgrep fallback otherwise
 *   - ashlr__edit  — diff-format edits that avoid sending full file contents
 *
 * Also tracks estimated tokens saved, persisted at ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { runWithTimeout } from "./_run-with-timeout";

import { statSync } from "fs";

import {
  estimateTokensFromString,
  formatGenomeForPrompt,
  genomeExists,
  type Message,
  snipCompact,
} from "@ashlr/core-efficiency";
import { retrieveCached } from "./_genome-cache";
import { refreshGenomeAfterEdit } from "./_genome-live";

import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { logEvent } from "./_events";
import { findParentGenome } from "../scripts/genome-link";
import { getCalibrationMultiplier } from "../scripts/read-calibration";
import {
  readStats,
  readCurrentSession,
  recordSaving,
  type LifetimeBucket,
  type SessionBucket,
} from "./_stats";
import { clampToCwd } from "./_cwd-clamp";
import { getEmbeddingCache } from "./_tool-base";
import { embed, upsertCorpus } from "./_embedding-model";
import { populateGenomeEmbeddings } from "./_genome-embed-populator";
import { createHash } from "crypto";
import { currentSessionId } from "./_stats";
import {
  buildTopProjects,
  readCalibrationState,
  renderPerProjectSection,
  renderBestDaySection,
  renderCalibrationLine,
  renderNudgeSection,
  type ExtraContext,
} from "../scripts/savings-report-extras";
// Shared with /ashlr-dashboard so the two surfaces agree on the today-vs-yesterday
// callout (parity gap flagged by Agent E in v1.18.1). The dashboard module is
// pure — importing it does not trigger any side effects on the MCP server path.
import { renderTodayVsYesterday } from "../scripts/savings-dashboard";
import { readNudgeSummary } from "./_nudge-events";
import { statSync as _statSync } from "fs";
import { homedir as _homedir } from "os";
import { join as _join } from "path";

function _hasProToken(): boolean {
  try {
    const p = _join(process.env.HOME ?? _homedir(), ".ashlr", "pro-token");
    const s = _statSync(p);
    return s.isFile() && s.size > 0;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Embedding cache — shared process-wide via _tool-base.getEmbeddingCache()
// ---------------------------------------------------------------------------

/** Stable 8-char project hash from absolute cwd path. */
function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}

/**
 * Cosine similarity threshold for a cache hit to prepend results.
 *
 * Baseline 0.68 (down from 0.75 in v1.12) — calibrated against the 24-doc
 * BM25 corpus where IDF weights are nearly flat and real similarity scores
 * cluster lower than classic dense-embedding expectations. Override via
 * `ASHLR_EMBED_THRESHOLD` (float in [0, 1]). A/B data flows to
 * `~/.ashlr/embed-calibration.jsonl` (see recordEmbedCalibration below).
 */
const EMBED_HIT_THRESHOLD = (() => {
  const raw = process.env.ASHLR_EMBED_THRESHOLD;
  if (!raw) return 0.68;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.68;
})();

/**
 * Minimum BM25 corpus size before the embedding cache is consulted. Below
 * this threshold, IDF weights are dominated by noise and nearly any query
 * produces a spurious hit — see v1.17 incident where a 6-doc corpus emitted
 * 0.7+ cosine hits on unrelated patterns.
 *
 * v1.18 Trust Pass: if docCount < THIS, the cache is skipped outright.
 * Reads `~/.ashlr/embed-corpus.json` directly (the writer lives in
 * `_embedding-model.ts`) so we don't have to export a new function.
 */
const BM25_CORPUS_MIN = 50;

function readCorpusDocCount(): number {
  try {
    const { readFileSync, existsSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const { homedir } = require("os") as typeof import("os");
    const p = join(process.env.HOME ?? homedir(), ".ashlr", "embed-corpus.json");
    if (!existsSync(p)) return 0;
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as { docCount?: number };
    return typeof parsed.docCount === "number" && Number.isFinite(parsed.docCount) ? parsed.docCount : 0;
  } catch {
    return 0;
  }
}

// Lightweight calibration log so we can tune EMBED_HIT_THRESHOLD from real data
// instead of guesses. Appends one JSONL record per grep call; fire-and-forget.
async function recordEmbedCalibration(record: {
  queryHashHex: string;
  topSimilarity: number;
  hit: boolean;
  contentLength: number;
  threshold: number;
}): Promise<void> {
  try {
    const { homedir } = await import("os");
    const { appendFile, mkdir } = await import("fs/promises");
    const { dirname, join } = await import("path");
    const path = join(process.env.HOME ?? homedir(), ".ashlr", "embed-calibration.jsonl");
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await appendFile(path, line, "utf-8");
  } catch {
    // Calibration log is observability, not critical path.
  }
}

// ---------------------------------------------------------------------------
// Pricing (used by the savings display — not by accounting)
//
// v1.18: imports from ./_pricing.ts so the efficiency-server renderer and
// scripts/savings-dashboard.ts resolve the same token count to the same
// dollar value. Prior to v1.18 these diverged ($3 vs $5 blended).
// ---------------------------------------------------------------------------

type ToolName = "ashlr__read" | "ashlr__grep" | "ashlr__edit" | "ashlr__sql" | "ashlr__bash";

import { pricing as _pricing, costFor as _costFor, pricingModel as _pricingModel, PRICING_TABLE } from "./_pricing";

// Re-export under the prior public name for any downstream importers. Shape
// intentionally matches the old `{ input, output }` record so generate-badge
// and the test assertion in generate-badge.test.ts keep working.
export const PRICING: Record<string, { input: number; output: number }> = Object.fromEntries(
  Object.entries(PRICING_TABLE).map(([k, v]) => [k, { input: v.inUsd, output: v.outUsd }]),
);
function pricingModel(): string { return _pricingModel(); }
function costFor(tokens: number, model?: string): number { return _costFor(tokens, model); }

// ---------------------------------------------------------------------------
// Savings report rendering
// ---------------------------------------------------------------------------

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function fmtCost(tokens: number): string {
  const c = costFor(tokens);
  if (c < 0.01) return `≈ $${c.toFixed(4)}`;
  return `≈ $${c.toFixed(2)}`;
}

function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) return "";
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(n);
}

function pct(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ASCII banner displayed at the top of every /ashlr-savings report.
// Must stay under 60 visible chars wide (tests assert <= 80).
export const SAVINGS_BANNER = [
  "  \u2584\u2580\u2588 \u2588\u2580\u2588 \u2588 \u2588 \u2588   \u2588\u2580\u2588",
  "  \u2588\u2580\u2588 \u2584\u2588 \u2588\u2580\u2588 \u2588\u2584\u2588   \u2588\u2580\u2580    token-efficient file tools",
].join("\n");

export function renderSavings(session: SessionBucket, lifetime: LifetimeBucket, extra?: ExtraContext): string {
  const model = pricingModel();
  const lines: string[] = [];
  lines.push(SAVINGS_BANNER);
  lines.push("");
  lines.push(`ashlr savings · session started ${formatAge(session.startedAt)} · model ${model}`);
  lines.push("");
  // Summary columns
  const sLabel = `  calls    ${session.calls}`;
  const lLabel = `calls    ${lifetime.calls}`;
  const sSaved = `  saved    ${session.tokensSaved.toLocaleString()} tok`;
  const lSaved = `saved    ${lifetime.tokensSaved.toLocaleString()} tok`;
  const sCost  = `  cost     ${fmtCost(session.tokensSaved)}`;
  const lCost  = `cost     ${fmtCost(lifetime.tokensSaved)}`;
  lines.push(`this session           all-time`);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(1, w - s.length));
  lines.push(pad(sLabel, 25) + lLabel);
  lines.push(pad(sSaved, 25) + lSaved);
  lines.push(pad(sCost, 25)  + lCost);
  lines.push("");

  // Today-vs-yesterday one-liner — shared with /ashlr-dashboard so the two
  // surfaces agree on when to celebrate a pace bump (or flag a slower day).
  // Returns "" (and is then skipped with no trailing blank) when quiet.
  const tvy = renderTodayVsYesterday(lifetime.byDay ?? {});
  if (tvy) {
    lines.push(tvy);
    lines.push("");
  }

  // By tool (session) — iterate whatever tools actually fired this session.
  lines.push("by tool (session):");
  const entries = Object.entries(session.byTool)
    .map(([name, pt]) => ({ name, calls: pt.calls, tokensSaved: pt.tokensSaved }))
    .filter((e) => e.calls > 0 || e.tokensSaved > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved);
  if (entries.length === 0) {
    lines.push("  (no calls yet this session)");
  } else {
    const maxTok = Math.max(...entries.map((e) => e.tokensSaved), 1);
    const totalTok = entries.reduce((s, e) => s + e.tokensSaved, 0);
    for (const e of entries) {
      const name = e.name.padEnd(14);
      const calls = `${e.calls} call${e.calls === 1 ? " " : "s"}`.padEnd(10);
      const tok = `${e.tokensSaved.toLocaleString()} tok`.padEnd(13);
      lines.push(`  ${name}${calls}${tok}${bar(e.tokensSaved, maxTok).padEnd(13)}${pct(e.tokensSaved, totalTok)}`);
    }
  }
  lines.push("");

  // Last 7 days
  lines.push("last 7 days:");
  const days = lastNDays(7);
  const dayVals = days.map((d) => ({ d, v: lifetime.byDay[d]?.tokensSaved ?? 0 }));
  const maxDay = Math.max(...dayVals.map((x) => x.v), 1);
  for (const { d, v } of dayVals) {
    const label = d.slice(5); // MM-DD
    const b = v === 0 ? "(quiet)     " : bar(v, maxDay, 20).padEnd(20);
    const val = v === 0 ? "       0" : v.toLocaleString();
    lines.push(`  ${label}  ${b}  ${val}`);
  }
  lines.push("");

  // Last 30 days rollup. The 7-day view above shows *shape*; this block shows
  // the *totals* — calls, tokens, dollars — plus the single best day. They're
  // complementary: sparkline answers "when did I work?", rollup answers "how
  // much did I save?".
  lines.push("last 30 days:");
  const monthDays = lastNDays(30);
  const activeEntries = monthDays
    .map((d) => ({ d, entry: lifetime.byDay[d] }))
    .filter((x) => x.entry && (x.entry.calls > 0 || x.entry.tokensSaved > 0)) as Array<{
      d: string;
      entry: { calls: number; tokensSaved: number };
    }>;

  // Require at least 2 distinct active days before claiming a "monthly" rollup;
  // otherwise the number is just "today" dressed up as a month and misleading.
  if (activeEntries.length < 2) {
    lines.push("  (not enough history yet — come back in a few weeks)");
  } else {
    const totalCalls = activeEntries.reduce((s, x) => s + x.entry.calls, 0);
    const totalTok = activeEntries.reduce((s, x) => s + x.entry.tokensSaved, 0);
    const best = activeEntries.reduce((a, b) => (b.entry.tokensSaved > a.entry.tokensSaved ? b : a));
    lines.push(`  calls     ${totalCalls.toLocaleString()}`);
    lines.push(`  saved     ${totalTok.toLocaleString()} tok   ${fmtCost(totalTok)}`);
    lines.push(
      `  best day  ${best.d}    ·  ${best.entry.tokensSaved.toLocaleString()} tok   ·  ${best.entry.calls} call${best.entry.calls === 1 ? "" : "s"}`,
    );
  }

  // Extra sections (appended; never remove existing ones)
  if (extra?.topProjects && extra.topProjects.length > 0) {
    lines.push("");
    lines.push(renderPerProjectSection(extra.topProjects));
  }

  const bestDay = renderBestDaySection(lifetime);
  if (bestDay) {
    lines.push("");
    lines.push(bestDay);
  }

  const nudgeSection = renderNudgeSection(extra?.nudgeSummary, extra?.proUser ?? false);
  if (nudgeSection) {
    lines.push("");
    lines.push(nudgeSection);
  }

  lines.push("");
  const calibLine = renderCalibrationLine(
    extra?.calibrationRatio ?? 4,
    extra?.calibrationPresent ?? false,
  );
  lines.push(calibLine);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool impls
// ---------------------------------------------------------------------------

// Per-process content cache for ashlr__read. Keyed by absolute path; the
// cached result is only reused when the file's mtimeMs matches — any write
// (ours via ashlr__edit, or external) invalidates. Lives for the MCP server
// lifetime, which aligns with a single Claude Code session.
interface ReadCacheEntry {
  mtimeMs: number;
  /** The exact string we would have returned on a miss. */
  result: string;
  /** Bytes of the original file when cached — for correct savings math on reuse. */
  sourceBytes: number;
}
const readCache: Map<string, ReadCacheEntry> = new Map();

/**
 * File extensions treated as code for the line-number-preservation path.
 * When ashlr__read returns a snipCompact-truncated view of one of these files,
 * every preserved line is prefixed with its original line number so Claude can
 * cite `file:line` accurately even across the elided middle.
 */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".rb", ".php", ".swift", ".cs", ".scala", ".cpp", ".c", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".proto", ".css", ".scss", ".html", ".vue", ".svelte",
]);

function isCodeFile(path: string): boolean {
  const m = path.match(/\.[a-zA-Z0-9]+$/);
  if (!m) return false;
  return CODE_EXTENSIONS.has(m[0].toLowerCase());
}

/**
 * Prepend every line with its 1-based line number + ": " so that head/tail
 * fragments surviving snipCompact still carry positional information. Line
 * numbers use right-justified padding so alignment stays consistent across
 * the file (cheap visual affordance when Claude reads the output).
 */
function numberCodeLines(source: string): string {
  const lines = source.split("\n");
  const pad = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(pad, " ")}: ${line}`).join("\n");
}

export async function ashlrRead(input: { path: string; bypassSummary?: boolean; preserveLineNumbers?: boolean }): Promise<string> {
  const clamp = clampToCwd(input.path, "ashlr__read");
  if (!clamp.ok) return clamp.message;
  const abs = clamp.abs;

  // Cache hit path: same absolute path + unchanged mtime → return cached
  // result tagged "(cached)" and record full savings (0 bytes emitted to the
  // model beyond the tiny tag, so treat output as ~cache_entry.result.length
  // for the saving calculation just like a miss would).
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(abs).mtimeMs;
    const hit = readCache.get(abs);
    if (hit && hit.mtimeMs === mtimeMs && input.bypassSummary !== true) {
      // On a repeat read we would otherwise have re-paid the full source
      // bytes → recompute path. Credit the original-size saving again since
      // the agent received zero new tokens of file content.
      await recordSaving(hit.sourceBytes, 0, "ashlr__read");
      return `(cached)\n${hit.result}`;
    }
  } catch {
    // If stat fails (broken symlink, perms), fall through to the normal read
    // path which will surface a descriptive error.
  }

  const content = await readFile(abs, "utf-8");

  // For code files, prepend 1-based line numbers to every line before
  // snipCompact runs so `file:line` citations survive truncation. Override
  // with { preserveLineNumbers: false } to get raw bytes back (e.g., when
  // feeding the output into another tool that doesn't tolerate the prefix).
  const preserveLineNumbers =
    input.preserveLineNumbers ?? isCodeFile(abs);
  const renderedContent = preserveLineNumbers
    ? numberCodeLines(content)
    : content;

  // Wrap as a fake tool_result message so snipCompact has something to snip.
  const msgs: Message[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "ashlr-read", content: renderedContent },
      ],
    },
  ];

  const compact = snipCompact(msgs);
  const block = (compact[0]!.content as { type: string; content: string }[])[0]!;
  const out = (block as { content: string }).content;

  // snipCompact aggressively truncates at 2KB, which throws away the middle of
  // large source files. For files > 16KB, summarize the raw content (the LLM
  // can preserve symbol-level structure snipCompact can't). Small files skip
  // summarization entirely (threshold check inside summarizeIfLarge).
  if (!(renderedContent.length > out.length)) {
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "small-file" });
  }
  const summarizeInput = renderedContent.length > out.length ? renderedContent : out;
  const summarized = await summarizeIfLarge(summarizeInput, {
    toolName: "ashlr__read",
    systemPrompt: PROMPTS.read,
    bypass: input.bypassSummary === true,
  });
  // Fall back to snipCompact output if summarize short-circuited (below threshold).
  const finalText = summarized.summarized || summarized.fellBack || input.bypassSummary ? summarized.text : out;
  const finalBytes = summarized.summarized || summarized.fellBack ? summarized.outputBytes : out.length;
  await recordSaving(content.length, finalBytes, "ashlr__read");

  const badgeOpts = {
    toolName: "ashlr__read",
    rawBytes: content.length,
    outputBytes: finalBytes,
    fellBack: summarized.fellBack,
    extra: mtimeMs > 0 ? `mtime=${mtimeMs}` : undefined,
  };
  if (confidenceTier(badgeOpts) === "low") {
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "low-confidence" });
  }
  const badge = confidenceBadge(badgeOpts);
  const finalTextWithBadge = finalText + badge;

  // Cache the fully computed result for this (path, mtimeMs). Skip caching
  // when bypassSummary was used — that's an opt-out path and shouldn't
  // poison future non-bypass calls.
  if (input.bypassSummary !== true && mtimeMs > 0) {
    readCache.set(abs, { mtimeMs, result: finalTextWithBadge, sourceBytes: content.length });
  }

  return finalTextWithBadge;
}

/**
 * Resolve rg via Bun.which (walks PATH and common Homebrew locations). Shell
 * aliases like Claude Code's own rg wrapper don't resolve under spawn, so we
 * need the actual binary. Returns "rg" as last resort so spawn can at least
 * surface a useful error.
 */
function resolveRg(): string {
  return (
    (typeof (globalThis as { Bun?: { which(bin: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(bin: string): string | null } }).Bun.which("rg")
      : null) ??
    ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find((p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }) ??
    "rg"
  );
}

/**
 * Estimate total matches by shelling out to `rg -c` (count-only, small
 * output). Returns null when rg is unavailable or the call fails — callers
 * should treat null as "unknown" rather than zero.
 *
 * This is the *confidence signal* for genome-routed greps: it lets the
 * caller tell the model "genome returned N sections, rg sees ~M total
 * matches" so an incomplete summary doesn't pass silently. Cost is tiny
 * (single-integer-per-file output) and timeout is short.
 */
async function estimateMatchCount(pattern: string, cwd: string): Promise<number | null> {
  try {
    const res = await runWithTimeout({
      command: resolveRg(),
      args: ["-c", pattern, cwd],
      timeoutMs: 3_000,
    });
    if (res.exitCode !== 0 && res.exitCode !== 1) return null; // 1 == no matches
    const out = res.stdout ?? "";
    if (!out.trim()) return 0;
    // `rg -c` output is `path:count` per line.
    let total = 0;
    for (const line of out.split("\n")) {
      const idx = line.lastIndexOf(":");
      if (idx < 0) continue;
      const n = parseInt(line.slice(idx + 1), 10);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  } catch {
    return null;
  }
}

export async function ashlrGrep(input: { pattern: string; cwd?: string; bypassSummary?: boolean }): Promise<string> {
  // Clamp input.cwd to process.cwd() — ripgrep spawns below use this path as
  // their search root, so an unclamped caller could exfiltrate /etc, /root,
  // etc. The parent-genome walk-up via findParentGenome() stays legitimate
  // because it only reads .ashlrcode/genome/ metadata in ancestor dirs, not
  // arbitrary files. Refuse outside paths at the top so downstream spawns
  // never see them.
  const clamp = clampToCwd(input.cwd, "ashlr__grep");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;

  // Prefer the local genome. If none, walk up to 4 parents (capped at $HOME)
  // looking for a workspace-level genome — e.g. a project under ~/Desktop/
  // can borrow ~/Desktop/.ashlrcode/genome/ when it has nothing of its own.
  let genomeRoot: string | null = null;
  let genomeIsParent = false;
  if (genomeExists(cwd)) {
    genomeRoot = cwd;
  } else {
    const parent = findParentGenome(cwd);
    if (parent) {
      genomeRoot = parent;
      genomeIsParent = true;
    }
  }

  if (!genomeRoot) {
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
  }

  // ------------------------------------------------------------------
  // Embedding cache — query before genome retrieval (fire-and-forget
  // upsert on completion; never blocks if cache is disabled or slow).
  // ------------------------------------------------------------------
  const pHash = projectHash(cwd);
  const sessionId = currentSessionId();
  let embedCachePrefix = "";
  // v1.18 Trust Pass: the BM25 IDF corpus produces noisy similarity scores
  // below ~50 docs — we've observed spurious 0.7+ hits on unrelated
  // patterns. Gate the cache read on corpus size so we never serve a
  // false-positive prefix from a thin corpus.
  const corpusSize = readCorpusDocCount();
  const embedCacheEnabled = corpusSize >= BM25_CORPUS_MIN;
  try {
    const ctxDb = getEmbeddingCache();

    // Populate the cache on first-seen / mtime-bumped manifest so the
    // similarity query below has something to match against. Watermarked,
    // so steady-state grep calls pay only a tiny stat() + JSON read.
    if (genomeRoot) {
      try {
        await populateGenomeEmbeddings(genomeRoot, { ctxDb, projectHash: pHash });
      } catch {
        // Populator must never break grep.
      }
    }

    if (embedCacheEnabled) {
      const queryVec = await embed(input.pattern);
      const hits = ctxDb.searchSimilar({ projectHash: pHash, embedding: queryVec, limit: 3 });
      const topHit = hits[0];
      const topSim = topHit?.similarity ?? 0;
      const isHit = Boolean(topHit) && topSim >= EMBED_HIT_THRESHOLD;
      let hitContentLength = 0;
      if (isHit) {
        const hitSections = hits
          .filter((h) => h.similarity >= EMBED_HIT_THRESHOLD)
          .map((h) => `[embedding-cache hit | sim=${h.similarity.toFixed(3)} | ${h.sectionPath}]\n${h.sectionText}`)
          .join("\n\n");
        hitContentLength = hitSections.length;
        const tokensSaved = Math.round(hitContentLength / 4);
        embedCachePrefix = hitSections + "\n\n";
        ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: true, tokensSaved });
      } else {
        ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: false, tokensSaved: 0 });
      }
      const queryHashHex = createHash("sha256").update(input.pattern).digest("hex").slice(0, 12);
      void recordEmbedCalibration({
        queryHashHex,
        topSimilarity: topSim,
        hit: isHit,
        contentLength: hitContentLength,
        threshold: EMBED_HIT_THRESHOLD,
      });
    } else {
      // Skip-gated: record a miss with tokensSaved=0 so dashboards still
      // reflect lookup activity. No embedding call, no prefix — so the raw
      // baseline below is unaffected and no false-positive content lands
      // in the response.
      ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: false, tokensSaved: 0 });
    }
  } catch {
    // Embedding cache errors must never break grep. Silently skip.
  }

  if (genomeRoot) {
    const sections = await retrieveCached(genomeRoot, input.pattern, 4000);
    if (sections.length === 0) {
      await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "genome-empty" });
    }
    if (sections.length > 0) {
      const formatted = formatGenomeForPrompt(sections);
      // Use empirical multiplier from ~/.ashlr/calibration.json when available;
      // falls back to 4× (hardcoded guess) when no calibration has been run.
      const grepsMultiplier = getCalibrationMultiplier();
      let rawBytesEstimate = formatted.length * grepsMultiplier;

      // ASHLR_CALIBRATE=1: run real rg --json in parallel to record the TRUE
      // raw bytes. Adds to normal work but never blocks the tool response.
      if (process.env.ASHLR_CALIBRATE === "1") {
        try {
          const calibRes = await runWithTimeout({
            command: resolveRg(),
            args: ["--json", "-n", input.pattern, cwd],
            timeoutMs: 5_000,
          });
          const trueRawBytes = Buffer.byteLength(calibRes.stdout, "utf-8");
          // Never underreport — take the max of empirical and estimated.
          rawBytesEstimate = Math.max(trueRawBytes, formatted.length * grepsMultiplier);
        } catch {
          // Calibration run failed — silently fall through to the estimate.
        }
      }

      // v1.18 Trust Pass invariant: neither side of recordSaving includes
      // `embedCachePrefix`. The cache prefix is response-only decoration;
      // counting its length as "raw bytes saved" would inflate savings on
      // every cache hit because we'd be crediting content we generated, not
      // content the agent would have otherwise fetched.
      await recordSaving(rawBytesEstimate, formatted.length, "ashlr__grep");
      // Run `rg -c` to get an independent estimate of total matches. If genome
      // returned only N sections but ripgrep would find 10× that, the model
      // needs to know it should escalate rather than trust a stale/partial
      // retrieval. This is the fix for the silent-incomplete-genome risk.
      const estimated = await estimateMatchCount(input.pattern, cwd);
      if (estimated !== null && estimated > sections.length * 4) {
        await logEvent("tool_escalate", {
          tool: "ashlr__grep",
          reason: "incomplete-genome",
          extra: { sections: sections.length, estimated },
        });
      }
      const parentNote = genomeIsParent ? ` (from parent genome at ${genomeRoot})` : "";
      const countNote =
        estimated === null
          ? ""
          : ` · rg estimates ${estimated.toLocaleString()} total match${estimated === 1 ? "" : "es"}${
              estimated > sections.length * 4
                ? " · call with bypassSummary:true for the full ripgrep list"
                : ""
            }`;
      const header = `[ashlr__grep] genome-retrieved ${sections.length} section(s)${parentNote}${countNote}`;
      const genomeBadgeOpts = {
        toolName: "ashlr__grep",
        rawBytes: Math.round(rawBytesEstimate),
        outputBytes: formatted.length,
      };
      if (confidenceTier(genomeBadgeOpts) === "low") {
        await logEvent("tool_noop", { tool: "ashlr__grep", reason: "low-confidence" });
      }
      return embedCachePrefix + `${header}\n\n${formatted}` + confidenceBadge(genomeBadgeOpts);
    }
  }

  const rgBin = resolveRg();

  const res = await runWithTimeout({
    command: rgBin,
    args: ["--json", "-n", input.pattern, cwd],
    timeoutMs: 15_000,
  });
  const raw = res.stdout ?? "";
  const truncated = raw.length > 4000 ? raw.slice(0, 2000) + "\n\n[... truncated ...]\n\n" + raw.slice(-1000) : raw;
  const summarized = await summarizeIfLarge(truncated, {
    toolName: "ashlr__grep",
    systemPrompt: PROMPTS.grep,
    bypass: input.bypassSummary === true,
  });
  await recordSaving(raw.length, summarized.outputBytes, "ashlr__grep");
  const rgBadgeOpts = {
    toolName: "ashlr__grep",
    rawBytes: raw.length,
    outputBytes: summarized.outputBytes,
    fellBack: summarized.fellBack,
  };
  if (confidenceTier(rgBadgeOpts) === "low") {
    await logEvent("tool_noop", { tool: "ashlr__grep", reason: "low-confidence" });
  }

  // Post-grep: upsert matched snippets into the embedding cache (fire-and-forget).
  setImmediate(() => {
    try {
      const snippet = (summarized.text || raw).slice(0, 2000);
      if (snippet.length > 50) {
        upsertCorpus(snippet);
        const ctxDb = getEmbeddingCache();
        // embed() is async — spawn a detached micro-task so we never await here.
        // best-effort: embedding upsert is a speculative cache fill after the tool already returned; a failure here cannot affect the user's result.
        embed(snippet).then((vec) => {
          ctxDb.upsertEmbedding({
            projectHash: pHash,
            sectionPath: `grep:${input.pattern}`,
            sectionText: snippet,
            embedding: vec,
            embeddingDim: vec.length,
            source: "code",
          });
        }).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  });

  return embedCachePrefix + (summarized.text || "[no matches]") + confidenceBadge(rgBadgeOpts);
}

export interface EditArgs {
  path: string;
  search: string;
  replace: string;
  /** When true (default), require exactly one match of `search` for safety. */
  strict?: boolean;
}

export interface EditResult {
  text: string;
  hunksApplied: number;
}

// ---------------------------------------------------------------------------
// Edit session log (for ashlr__flush summary)
//
// All edits write immediately to disk. This is the safe design: the MCP SDK
// dispatches requests concurrently, so a deferred-write queue would create
// races where a read arrives before the preceding edit's timer fires.
//
// ashlr__flush is a "what did I just write?" reporting tool — it returns a
// compact summary of edits applied since the last flush, which lets the
// agent confirm what landed without re-reading the full files.
// ---------------------------------------------------------------------------

interface EditLogEntry {
  relPath: string;
  hunksApplied: number;
}

const editLog: EditLogEntry[] = [];

/** Summarize edits applied since the last flush (or session start). */
export async function flushPending(): Promise<string> {
  if (editLog.length === 0) return "";
  const batch = editLog.splice(0, editLog.length);
  const lines = [`[ashlr__flush] ${batch.length} edit(s) applied this batch:`];
  for (const e of batch) {
    lines.push(`  ok  ${e.relPath} (${e.hunksApplied} hunk${e.hunksApplied === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

/** Levenshtein distance (capped at maxDist for speed). */
function levenshtein(a: string, b: string, maxDist = 256): number {
  if (a === b) return 0;
  if (a.length === 0) return Math.min(b.length, maxDist);
  if (b.length === 0) return Math.min(a.length, maxDist);
  // Truncate both to keep work bounded
  const A = a.slice(0, 200);
  const B = b.slice(0, 200);
  const m = A.length, n = B.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Return top-3 closest lines to `search` from `content`, with similarity scores. */
function fuzzyTopLines(
  search: string,
  content: string,
): Array<{ lineNo: number; text: string; sim: number }> {
  const needle = search.split("\n")[0].trim().slice(0, 200);
  const lines = content.split("\n");
  const results: Array<{ lineNo: number; text: string; sim: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const dist = levenshtein(needle, line.slice(0, 200));
    const maxLen = Math.max(needle.length, line.length, 1);
    const sim = Math.round((1 - dist / maxLen) * 100) / 100;
    results.push({ lineNo: i + 1, text: lines[i], sim });
  }
  results.sort((a, b) => b.sim - a.sim);
  return results.slice(0, 3);
}

const FUZZY_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MB

export async function ashlrEdit(input: EditArgs): Promise<EditResult> {
  const { path: relPath, search, replace, strict = true } = input;
  if (!search) throw new Error("ashlr__edit: 'search' must not be empty");

  const clamp = clampToCwd(relPath, "ashlr__edit");
  if (!clamp.ok) throw new Error(clamp.message);
  const abs = clamp.abs;
  const original = await readFile(abs, "utf-8");

  let count = 0;
  let idx = 0;
  while ((idx = original.indexOf(search, idx)) !== -1) { count++; idx += search.length; }

  if (count === 0) {
    if (strict && original.length <= FUZZY_SIZE_LIMIT) {
      const candidates = fuzzyTopLines(search, original);
      const hint = candidates.length
        ? "\nClosest lines in file:\n" +
          candidates.map(c => `  ${c.lineNo}:  ${c.text.slice(0, 120)}  (sim=${c.sim.toFixed(2)})`).join("\n")
        : "";
      throw new Error(`ashlr__edit: no match for search string in ${relPath} (strict mode).${hint}`);
    }
    throw new Error(`ashlr__edit: search string not found in ${relPath}`);
  }
  if (strict && count > 1) {
    throw new Error(
      `ashlr__edit: search string matched ${count} times in ${relPath}; pass strict:false to replace all, or widen the context to a unique span.`,
    );
  }

  const updated = strict
    ? original.replace(search, replace)
    : original.split(search).join(replace);

  await writeFile(abs, updated, "utf-8");

  // Invalidate read-cache so subsequent ashlr__read calls see new content.
  const hit = readCache.get(abs);
  if (hit) readCache.set(abs, { ...hit, mtimeMs: -1 });

  // best-effort: refreshGenomeAfterEdit already swallows internally; this outer catch guards against a pre-try sync throw so edits never fail because of observability.
  refreshGenomeAfterEdit(abs, original, updated).catch(() => {});

  // v1.18 Trust Pass: baseline is what Claude Code would have SENT for a
  // native Edit — search + replace, NOT the full file twice. The prior
  // `original.length + updated.length` inflated savings 2–5× because it
  // counted the entire file twice even for a one-line change.
  const naiveBytes = search.length + replace.length;
  const compactSummary = summarizeEdit(relPath, search, replace, count, strict);
  await recordSaving(naiveBytes, compactSummary.length, "ashlr__edit");

  const hunksApplied = strict ? 1 : count;
  editLog.push({ relPath, hunksApplied });

  return { text: compactSummary, hunksApplied };
}

function summarizeEdit(
  relPath: string,
  search: string,
  replace: string,
  matchCount: number,
  strict: boolean,
): string {
  const first = (s: string) => s.split("\n")[0]?.slice(0, 72) ?? "";
  return [
    `[ashlr__edit] ${relPath}  ·  ${strict ? "1 of " + matchCount : matchCount + " of " + matchCount} hunks applied`,
    `  - removed (${estimateTokensFromString(search)} tok):  ${first(search)}${search.length > 72 ? "…" : ""}`,
    `  + added   (${estimateTokensFromString(replace)} tok):  ${first(replace)}${replace.length > 72 ? "…" : ""}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-efficiency", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__read",
      description: "Read a file with automatic snipCompact truncation for results > 2KB. Preserves head + tail, elides middle. Lower-token alternative to the built-in Read tool.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          bypassSummary: { type: "boolean", description: "Skip LLM summarization, return snipCompact-truncated content (default: false)" },
        },
        required: ["path"],
      },
    },
    {
      name: "ashlr__grep",
      description: "Search for a pattern. When a .ashlrcode/genome/ directory exists, uses genome-aware retrieval to return only the most relevant sections. Falls back to ripgrep otherwise.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Query or regex" },
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
          bypassSummary: { type: "boolean", description: "Skip LLM summarization, return rg output as-is (default: false)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "ashlr__edit",
      description: "Apply a search/replace edit in-place and return only a diff summary. In strict mode (default), requires exactly one match for safety. Set strict:false to replace all occurrences.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          search: { type: "string", description: "Exact text to find" },
          replace: { type: "string", description: "Replacement text" },
          strict: { type: "boolean", description: "Require exactly one match (default: true)" },
        },
        required: ["path", "search", "replace"],
      },
    },
    {
      name: "ashlr__flush",
      description: "Flush all queued ashlr__edit writes to disk immediately and return a summary of what was committed. Use when you need to read a file you just edited, or at the end of a multi-edit sequence.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ashlr__savings",
      description: "Return estimated tokens saved in the current session and lifetime totals.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "ashlr__read": {
        const text = await ashlrRead(args as { path: string; bypassSummary?: boolean });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__grep": {
        const text = await ashlrGrep(args as { pattern: string; cwd?: string; bypassSummary?: boolean });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__edit": {
        const res = await ashlrEdit(args as unknown as EditArgs);
        return { content: [{ type: "text", text: res.text }] };
      }
      case "ashlr__flush": {
        const summary = await flushPending();
        return { content: [{ type: "text", text: summary || "[ashlr__flush] nothing to flush" }] };
      }
      case "ashlr__savings": {
        const stats = await readStats();
        const session = await readCurrentSession();
        const topProjects = buildTopProjects(
          process.env.HOME ?? process.env.USERPROFILE,
        );
        const { ratio: calibrationRatio, present: calibrationPresent } = readCalibrationState();
        const nudgeSummary = await readNudgeSummary();
        const proUser = _hasProToken();
        const extra: ExtraContext = { topProjects, calibrationRatio, calibrationPresent, nudgeSummary, proUser };
        return {
          content: [{ type: "text", text: renderSavings(session, stats.lifetime, extra) }],
        };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
