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
function statsPath(): string  { return join(home(), ".ashlr", "stats.json"); }

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
    return { text: rawText, summarized: false, wasCached: false, fellBack: false, outputBytes: rawBytes };
  }
  if (opts.bypass) {
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
  const apiKey = process.env.ASHLR_LLM_KEY ?? "local-llm";
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
// Stats — write summarization counters into ~/.ashlr/stats.json
// ---------------------------------------------------------------------------

async function bumpStat(field: "calls" | "cacheHits"): Promise<void> {
  const path = statsPath();
  try {
    let data: any = {};
    if (existsSync(path)) {
      try { data = JSON.parse(await readFile(path, "utf-8")); } catch { data = {}; }
    }
    data.summarization = data.summarization ?? { calls: 0, cacheHits: 0 };
    data.summarization[field] = (data.summarization[field] ?? 0) + 1;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
  } catch {
    // Stats are best-effort; never throw.
  }
}

// ---------------------------------------------------------------------------
// Per-tool prompts (exported so wiring code references them by name, not by string)
// ---------------------------------------------------------------------------

export const PROMPTS = {
  read:
    "You are summarizing a source code file for an AI coding agent. Output ≤500 chars. " +
    "Preserve: file purpose (1 sentence), exported symbols (with line numbers like 'foo at L42'), " +
    "key functions/classes (1 line each, with line ranges), notable patterns or gotchas. " +
    "Preserve any TODO/FIXME/XXX/HACK markers verbatim with their line numbers. " +
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
} as const;
