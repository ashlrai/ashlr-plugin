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
import { spawnSync } from "child_process";

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
import {
  buildTopProjects,
  readCalibrationState,
  renderPerProjectSection,
  renderBestDaySection,
  renderCalibrationLine,
  type ExtraContext,
} from "../scripts/savings-report-extras";

// ---------------------------------------------------------------------------
// Pricing (used by the savings display — not by accounting)
// ---------------------------------------------------------------------------

type ToolName = "ashlr__read" | "ashlr__grep" | "ashlr__edit" | "ashlr__sql" | "ashlr__bash";

// Pricing: USD per million tokens. Default sonnet-4.5 input pricing.
export const PRICING: Record<string, { input: number; output: number }> = {
  "sonnet-4.5": { input: 3.0, output: 15.0 },
  "opus-4":     { input: 15.0, output: 75.0 },
  "haiku-4.5":  { input: 0.8, output: 4.0 },
};
const PRICING_MODEL_DEFAULT = "sonnet-4.5";
function pricingModel(): string {
  return process.env.ASHLR_PRICING_MODEL || PRICING_MODEL_DEFAULT;
}
function costFor(tokens: number, model = pricingModel()): number {
  const p = PRICING[model] ?? PRICING[PRICING_MODEL_DEFAULT]!;
  return (tokens * p.input) / 1_000_000;
}

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

function renderSavings(session: SessionBucket, lifetime: LifetimeBucket, extra?: ExtraContext): string {
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

export async function ashlrRead(input: { path: string; bypassSummary?: boolean }): Promise<string> {
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

  // Wrap as a fake tool_result message so snipCompact has something to snip.
  const msgs: Message[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "ashlr-read", content },
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
  if (!(content.length > out.length)) {
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "small-file" });
  }
  const summarizeInput = content.length > out.length ? content : out;
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
function estimateMatchCount(pattern: string, cwd: string): number | null {
  try {
    const res = spawnSync(resolveRg(), ["-c", pattern, cwd], {
      encoding: "utf-8",
      timeout: 3_000,
    });
    if (res.status !== 0 && res.status !== 1) return null; // 1 == no matches
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
          const calibRes = spawnSync(resolveRg(), ["--json", "-n", input.pattern, cwd], {
            encoding: "buffer",
            timeout: 5_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          const calibBuf = calibRes.stdout as Buffer | null;
          const trueRawBytes = calibBuf ? calibBuf.length : 0;
          // Never underreport — take the max of empirical and estimated.
          rawBytesEstimate = Math.max(trueRawBytes, formatted.length * grepsMultiplier);
        } catch {
          // Calibration run failed — silently fall through to the estimate.
        }
      }

      await recordSaving(rawBytesEstimate, formatted.length, "ashlr__grep");
      // Run `rg -c` to get an independent estimate of total matches. If genome
      // returned only N sections but ripgrep would find 10× that, the model
      // needs to know it should escalate rather than trust a stale/partial
      // retrieval. This is the fix for the silent-incomplete-genome risk.
      const estimated = estimateMatchCount(input.pattern, cwd);
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
      return `${header}\n\n${formatted}` + confidenceBadge(genomeBadgeOpts);
    }
  }

  const rgBin = resolveRg();

  const res = spawnSync(rgBin, ["--json", "-n", input.pattern, cwd], {
    encoding: "utf-8",
    timeout: 15_000,
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
  return (summarized.text || "[no matches]") + confidenceBadge(rgBadgeOpts);
}

interface EditArgs {
  path: string;
  search: string;
  replace: string;
  /** When true (default), require exactly one match of `search` for safety. */
  strict?: boolean;
}

interface EditResult {
  text: string;
  hunksApplied: number;
}

// ---------------------------------------------------------------------------
// Edit session log (for ashlr__flush summary)
//
// All edits write immediately to disk — this is the safe design because the
// MCP SDK dispatches requests concurrently, so a deferred-write queue would
// create races where a read arrives before its preceding edit's timer fires.
//
// ashlr__flush is therefore a "what did I just write?" reporting tool rather
// than a deferred-flush trigger. It returns a compact summary of all edits
// applied since the last flush (or session start), which lets the agent
// confirm what landed without re-reading the full files.
//
// ensureFlushed() is a no-op for safety — kept so callers compile cleanly.
// ---------------------------------------------------------------------------

interface EditLogEntry {
  relPath: string;
  search: string;
  replace: string;
  hunksApplied: number;
  appliedAt: number;
}

const editLog: EditLogEntry[] = [];

/** No-op — all edits write immediately. Kept for API compatibility. */
export async function flushPending(): Promise<string> {
  if (editLog.length === 0) return "";
  const batch = editLog.splice(0, editLog.length);
  const lines = [`[ashlr__flush] ${batch.length} edit(s) applied this batch:`];
  for (const e of batch) {
    lines.push(`  ok  ${e.relPath} (${e.hunksApplied} hunk${e.hunksApplied === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

/** No-op — writes are always immediate. Kept so wiring code compiles. */
async function ensureFlushed(): Promise<void> { /* no-op: all edits are immediate */ }

async function ashlrEdit(input: EditArgs): Promise<EditResult> {
  const { path: relPath, search, replace, strict = true } = input;
  if (!search) throw new Error("ashlr__edit: 'search' must not be empty");

  const clamp = clampToCwd(relPath, "ashlr__edit");
  if (!clamp.ok) throw new Error(clamp.message);
  const abs = clamp.abs;
  const original = await readFile(abs, "utf-8");

  let count = 0;
  let idx = 0;
  while ((idx = original.indexOf(search, idx)) !== -1) { count++; idx += search.length; }

  if (count === 0) throw new Error(`ashlr__edit: search string not found in ${relPath}`);
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
  try {
    const { mtimeMs } = require("fs").statSync(abs);
    const hit = readCache.get(abs);
    if (hit) readCache.set(abs, { ...hit, mtimeMs: -1 });
  } catch { /* best-effort */ }

  refreshGenomeAfterEdit(abs, original, updated).catch(() => {});

  const naiveBytes = original.length + updated.length;
  const compactSummary = summarizeEdit(relPath, search, replace, count, strict);
  await recordSaving(naiveBytes, compactSummary.length, "ashlr__edit");

  const hunksApplied = strict ? 1 : count;
  editLog.push({ relPath, search, replace, hunksApplied, appliedAt: Date.now() });

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
        await ensureFlushed();
        const text = await ashlrRead(args as { path: string; bypassSummary?: boolean });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__grep": {
        await ensureFlushed();
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
        await ensureFlushed();
        const stats = await readStats();
        const session = await readCurrentSession();
        const topProjects = buildTopProjects();
        const { ratio: calibrationRatio, present: calibrationPresent } = readCalibrationState();
        const extra: ExtraContext = { topProjects, calibrationRatio, calibrationPresent };
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
