/**
 * Shared LLM summarization helper for ashlr MCP tools.
 *
 * Replaces dumb truncation with smart summarization for the cases where
 * the middle of a large output actually matters (large source files, big
 * diffs, log tails with errors buried mid-stream, etc.).
 *
 * Architecture
 * - Local-first: defaults to LM Studio at http://localhost:1234/v1
 * - Cloud override via $ASHLR_LLM_URL + $ASHLR_LLM_KEY (preserves the
 *   "no account, no telemetry" positioning — only used if user opts in)
 * - 5s timeout per call; on failure, falls back to a snipCompact-style
 *   truncation with an explicit "[LLM unreachable]" note
 * - SHA-256 cache at ~/.ashlr/summary-cache/<hash>.txt (1h TTL)
 * - Always appends a one-line hint so the agent knows it can ask for the
 *   full output via bypassSummary:true
 *
 * Re-uses the OpenAI-compat shim pattern from servers/genome-server.ts;
 * intentionally duplicated here (zero coupling between the two servers).
 */

import { existsSync } from "fs";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Confidence badge — pure helper, no I/O
// ---------------------------------------------------------------------------

export interface ConfidenceBadgeOpts {
  /** Tool name for the escalation hint (e.g. "ashlr__read"). */
  toolName: string;
  /** Raw bytes before compression. */
  rawBytes: number;
  /** Output bytes after compression. */
  outputBytes: number;
  /** True if the LLM fell back to truncation. Always → low tier. */
  fellBack?: boolean;
  /** True if the command exited non-zero AND bytes were elided. Always → low. */
  nonZeroExit?: boolean;
  /** Optional extra tag appended before the closing bracket (e.g. "mtime=123"). */
  extra?: string;
}

type ConfidenceTier = "high" | "medium" | "low";

function _tier(opts: ConfidenceBadgeOpts): ConfidenceTier {
  if (opts.fellBack || opts.nonZeroExit) return "low";
  // Nothing to compress → trivially "high" (no information lost).
  if (opts.rawBytes <= 0) return "high";
  // Everything was elided — the exact opposite of high confidence.
  if (opts.outputBytes <= 0) return "low";
  const ratio = opts.outputBytes / opts.rawBytes;
  if (ratio >= 1 / 3) return "high";
  if (ratio >= 1 / 8) return "medium";
  return "low";
}

/** Exposed so call sites can branch on tier (e.g. to emit a logEvent). */
export function confidenceTier(opts: ConfidenceBadgeOpts): ConfidenceTier {
  return _tier(opts);
}

/**
 * Return a one-line confidence footer to append to compressed tool output.
 * Returns an empty string when no compression occurred (rawBytes ≤ outputBytes)
 * so call sites can always do `text + confidenceBadge(...)` safely.
 *
 * The returned string (when non-empty) is ≤ 80 chars and starts with "\n".
 */
export function confidenceBadge(opts: ConfidenceBadgeOpts): string {
  // No compression and no failure signal → no badge. Also skip when the
  // raw payload is tiny — a badge on a sub-512-byte response is more noise
  // than signal. fellBack/nonZeroExit still emit (they're load-bearing
  // quality signals regardless of payload size).
  if (!opts.fellBack && !opts.nonZeroExit) {
    if (opts.rawBytes <= opts.outputBytes) return "";
    if (opts.rawBytes < 512) return "";
  }

  const tier = _tier(opts);
  const rawKB = (opts.rawBytes / 1024).toFixed(0) + "KB";
  const outKB = (opts.outputBytes / 1024).toFixed(0) + "KB";
  const extraPart = opts.extra ? ` · ${opts.extra}` : "";

  // 80-char budget. Required pieces (always included): tier name + the
  // actionable `bypassSummary:true` hint. Optional pieces dropped under
  // pressure in order: (1) byte numbers, (2) the hint wording shortens.
  // `extra` (when caller passes one) is treated as required — it's how
  // callers thread debug context (e.g. mtime) into the badge.
  const BUDGET = 80;
  const hint = tier === "low"
    ? "bypassSummary:true to recover fidelity"
    : "bypassSummary:true recovers fidelity";

  const withBytes = `[ashlr confidence: ${tier} · ${rawKB}→${outKB}${extraPart} · ${hint}]`;
  const withoutBytes = `[ashlr confidence: ${tier}${extraPart} · ${hint}]`;
  const minimal = `[ashlr confidence: ${tier} · ${hint}]`;

  let line = withBytes;
  if (line.length > BUDGET) line = withoutBytes;
  if (line.length > BUDGET) line = minimal;
  if (line.length > BUDGET) line = line.slice(0, BUDGET - 1) + "]";

  return "\n" + line;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_THRESHOLD_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PROMPT_VERSION = 1; // bump if you change any per-tool prompt

// Resolve at call-time so tests overriding $HOME work correctly.
// Prefer $HOME env (test-friendly) over homedir() (which reads /etc/passwd).
function home(): string       { return process.env.HOME ?? homedir(); }
function cacheDir(): string   { return join(home(), ".ashlr", "summary-cache"); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SummarizeOpts {
  /** Tool name for cache keying + savings accounting (e.g. "ashlr__read"). */
  toolName: string;
  /** Per-tool system prompt — what to preserve, what to compress. */
  systemPrompt: string;
  /** Threshold below which raw text is returned as-is. Default 16 KB. */
  thresholdBytes?: number;
  /** Bypass summarization entirely (return raw text + bypass note). */
  bypass?: boolean;
  /** LLM call timeout. Default 5000ms. */
  timeoutMs?: number;
  /** Test hook: override LLM endpoint URL. */
  endpointOverride?: string;
}

export interface SummarizeResult {
  /** Output to return to the agent (summary + hint, OR raw text). */
  text: string;
  /** True if the LLM was actually called (false if under threshold or bypass). */
  summarized: boolean;
  /** True if served from cache. */
  wasCached: boolean;
  /** True if the LLM failed and we fell back to truncation. */
  fellBack: boolean;
  /** Compact size after summarization (or raw size if not summarized). */
  outputBytes: number;
}

/**
 * If `rawText` is large enough, summarize it via the LLM. Otherwise return
 * unchanged. Always safe — never throws, never blocks indefinitely.
 */
export async function summarizeIfLarge(
  rawText: string,
  opts: SummarizeOpts,
): Promise<SummarizeResult> {
  const threshold = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const rawBytes = Buffer.byteLength(rawText, "utf-8");

  // Below threshold or explicit bypass → no summarization.
  if (rawBytes <= threshold) {
    await logEvent("tool_noop", { tool: opts.toolName, reason: "below-threshold" });
    return { text: rawText, summarized: false, wasCached: false, fellBack: false, outputBytes: rawBytes };
  }
  if (opts.bypass) {
    await logEvent("tool_noop", { tool: opts.toolName, reason: "bypassed" });
    return {
      text: rawText + "\n\n[ashlr · summarization bypassed (bypassSummary:true)]",
      summarized: false,
      wasCached: false,
      fellBack: false,
      outputBytes: rawBytes,
    };
  }

  // Cache check
  const cacheKey = sha256(opts.toolName + "::" + PROMPT_VERSION + "::" + rawText);
  const cachePath = join(cacheDir(), `${cacheKey}.txt`);
  const cached = await readCache(cachePath);
  if (cached) {
    await bumpStat("cacheHits");
    const out = cached + "\n" + bypassHint(rawBytes, Buffer.byteLength(cached, "utf-8"));
    return {
      text: out,
      summarized: true,
      wasCached: true,
      fellBack: false,
      outputBytes: Buffer.byteLength(out, "utf-8"),
    };
  }

  // Call the LLM
  await bumpStat("calls");
  const summary = await callLLM(rawText, opts).catch(() => null);

  if (summary == null) {
    // Graceful degradation: snipCompact-style fallback
    await logEvent("tool_fallback", { tool: opts.toolName, reason: "llm-unreachable" });
    const fallback = snipFallback(rawText) + "\n\n[ashlr · LLM unreachable, fell back to truncation]";
    return {
      text: fallback,
      summarized: false,
      wasCached: false,
      fellBack: true,
      outputBytes: Buffer.byteLength(fallback, "utf-8"),
    };
  }

  // Persist to cache (best-effort)
  await writeCache(cachePath, summary).catch(() => undefined);

  const out = summary + "\n" + bypassHint(rawBytes, Buffer.byteLength(summary, "utf-8"));
  return {
    text: out,
    summarized: true,
    wasCached: false,
    fellBack: false,
    outputBytes: Buffer.byteLength(out, "utf-8"),
  };
}

// ---------------------------------------------------------------------------
// LLM call (local-first, env-override for cloud)
// ---------------------------------------------------------------------------

async function callLLM(rawText: string, opts: SummarizeOpts): Promise<string | null> {
  const url = opts.endpointOverride ?? llmEndpoint();
  // When pro-token auto-routing is active, use the pro token as the bearer
  // credential for the hosted endpoint. Fall back to ASHLR_LLM_KEY or the
  // "local-llm" placeholder for local Ollama / LM Studio.
  const apiKey =
    process.env.ASHLR_LLM_KEY ??
    (process.env.ASHLR_PRO_TOKEN && !process.env.ASHLR_LLM_URL
      ? process.env.ASHLR_PRO_TOKEN
      : "local-llm");
  const model = process.env.ASHLR_LLM_MODEL ?? "qwen/qwen3-coder-30b@8bit";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 800,
        temperature: 0.1,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: rawText },
        ],
      }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

function llmEndpoint(): string {
  // Pro-token auto-routing: when ASHLR_PRO_TOKEN is set and the user has NOT
  // explicitly configured a custom LLM endpoint, default to the hosted
  // ashlr cloud summarizer so pro users get cloud inference without any
  // manual configuration.
  if (process.env.ASHLR_PRO_TOKEN && !process.env.ASHLR_LLM_URL) {
    const base = process.env.ASHLR_API_URL ?? "https://api.ashlr.ai";
    return `${base}/llm`;
  }
  return process.env.ASHLR_LLM_URL ?? "http://localhost:1234/v1";
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function readCache(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > CACHE_TTL_MS) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function writeCache(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Fallback + hints
// ---------------------------------------------------------------------------

function snipFallback(raw: string): string {
  if (raw.length <= 2000) return raw;
  return raw.slice(0, 800) + "\n\n[... " + (raw.length - 1600) + " bytes elided ...]\n\n" + raw.slice(-800);
}

function bypassHint(rawBytes: number, summaryBytes: number): string {
  const ratio = rawBytes > 0 ? (rawBytes / summaryBytes).toFixed(1) : "?";
  return `[ashlr summary · ${rawBytes.toLocaleString()} → ${summaryBytes.toLocaleString()} bytes · ${ratio}× reduction · pass bypassSummary:true to see full output]`;
}

// ---------------------------------------------------------------------------
// Stats — delegate to shared _stats.ts so all writes share one lock+schema.
// ---------------------------------------------------------------------------

import { bumpSummarization } from "./_stats";
import { logEvent } from "./_events";

async function bumpStat(field: "calls" | "cacheHits"): Promise<void> {
  try { await bumpSummarization(field); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Per-tool prompts (exported so wiring code references them by name, not by string)
// ---------------------------------------------------------------------------

export const PROMPTS = {
  read:
    "You are summarizing a source code file for an AI coding agent. Output ≤500 chars. " +
    "Preserve: file purpose (1 sentence), key functions/classes (1 line each with line ranges). " +
    "Preserve VERBATIM with line numbers: every @-prefixed decorator or annotation (@deprecated, " +
    "@Injectable, @staticmethod, etc.) with its associated symbol; every " +
    "TODO|FIXME|XXX|HACK|WARNING|THREAD-UNSAFE|DEPRECATED|NOTE|SAFETY marker; " +
    "every top-level export/module.exports/__all__ statement (symbol name only, not body). " +
    "Output as plain text — no markdown headers.",

  diff:
    "You are summarizing a git diff for an AI coding agent. Output ≤500 chars. " +
    "Preserve: changed file paths (each on its own line with +adds/-dels), refactor signatures " +
    "(X→Y renames, signature changes), breaking changes (interface/export changes), " +
    "test-coverage shifts. Preserve hunk headers like '@@ -45,6 +45,14 @@' verbatim where they exist. " +
    "Skip pure-formatting changes. Output as plain text.",

  logs:
    "You are extracting signal from a log file for a debugging agent. Output ≤600 chars. " +
    "Preserve VERBATIM: the first error and its full stack trace, the most recent error and its trace, " +
    "any 'caused by' chains. Summarize: count of errors/warnings by category, " +
    "deduplicated repetition patterns ('connection timeout x47'), notable preceding warnings. " +
    "Output as plain text. Do not invent context that isn't in the logs.",

  grep:
    "You are summarizing grep results for a code-navigation agent. Output ≤400 chars. " +
    "Preserve VERBATIM: the top 3 matches with full file:line:content. " +
    "Summarize: total matches, file distribution (which files have the most), dominant pattern type. " +
    "Output as plain text — keep file paths fully qualified.",

  bash:
    "You are summarizing shell command output for an AI agent. Output ≤500 chars. " +
    "Preserve VERBATIM: errors with full stack traces, the final result line " +
    "(e.g. '187 passed', 'Build failed', exit code), key counts/identifiers. " +
    "Summarize: progress phases (compile → test → build), warnings by category. " +
    "Output as plain text. Do not embellish.",

  sql:
    "You are summarizing a SQL query result for a data-exploration agent. Output ≤400 chars. " +
    "Preserve VERBATIM: the first 3 and last 2 rows. " +
    "Summarize: total row count, column types, dominant values per column (e.g. 'status: 80% active, 15% pending'), " +
    "notable outliers (max, min, NULL counts). Output as plain text — keep numbers exact.",

  webfetch:
    "You are summarizing a fetched web page for an AI coding agent. Output ≤500 chars. " +
    "Preserve VERBATIM: the page title, all headings (as '# Heading' / '## Sub'), the first paragraph, " +
    "all hyperlinks with anchor text and URL (format: 'text (url)'), any error or warning messages. " +
    "Summarize: the main topic, key findings or data points, and any actionable content. " +
    "Omit boilerplate, nav menus, cookie notices, and marketing copy. Output as plain text.",

  http:
    "You are summarizing an HTTP response for an AI coding agent. Output ≤500 chars. " +
    "Preserve VERBATIM: status code, content-type, all headings, the first paragraph, key data fields " +
    "(especially IDs, URLs, error codes, and counts), all hyperlinks. " +
    "For JSON: preserve top-level keys, the first 3 array items verbatim, and total array lengths. " +
    "For HTML: same rules as webfetch — title, headings, first paragraph, links. " +
    "Omit boilerplate, nav, and cookie notices. Output as plain text.",

  glob:
    "You are summarizing a file glob result for an AI coding agent. Output ≤400 chars. " +
    "Preserve VERBATIM: the top 5 matching paths. " +
    "Summarize: total match count, top-level directory distribution with counts (e.g. 'src/: 42, tests/: 18'), " +
    "any non-obvious structural cues (e.g. nested package layout, monorepo roots). " +
    "Output as plain text — keep file paths fully qualified.",

  tree:
    "You are summarizing a project directory tree for an AI coding agent. Output ≤400 chars. " +
    "Preserve VERBATIM: the top-level directory names and their immediate children counts. " +
    "Summarize: total dirs and files, dominant file types by extension with counts, " +
    "any non-obvious structural cues (e.g. monorepo packages/, multiple entry points, config clusters). " +
    "Output as plain text — no markdown headers.",

  diff_semantic:
    "You are summarizing an AST-aware semantic diff for an AI coding agent. Output ≤500 chars. " +
    "Preserve VERBATIM: every detected rename row (old→new), signature-only change rows " +
    "(file:line: old-sig → new-sig), and the final counts header line. " +
    "Summarize: the total files touched, dominant change category (rename | signature | format | mixed), " +
    "whether any breaking-surface (exported symbol) changed. Drop pure-formatting chatter. " +
    "Output as plain text — no markdown headers.",
} as const;
