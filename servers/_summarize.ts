/**
 * Shared LLM summarization helper for ashlr MCP tools.
 *
 * Replaces dumb truncation with smart summarization for the cases where
 * the middle of a large output actually matters (large source files, big
 * diffs, log tails with errors buried mid-stream, etc.).
 *
 * Architecture (v1.22 Track D — LLM Hybrid Strategy)
 * - Provider hierarchy: Anthropic Haiku 4.5 → ONNX (stubbed) → Local LM Studio → snipCompact
 * - ASHLR_LLM_PROVIDER controls selection: "auto" (default) | "anthropic" | "onnx" | "local" | "off"
 * - "auto" tries Anthropic first (ANTHROPIC_API_KEY or ~/.claude/.credentials.json),
 *   then ONNX (when bundled), then local LM Studio at ASHLR_LLM_URL
 * - SHA-256 cache at ~/.ashlr/summary-cache/<hash>.txt (1h TTL)
 * - Always appends a one-line hint so the agent knows it can ask for the
 *   full output via bypassSummary:true
 *
 * Public API: summarizeIfLarge() — re-exported from ./_llm-providers/index.ts.
 * All callers import from this file; internal implementation lives in
 * ./_llm-providers/ to keep concerns separated.
 */

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

// ---------------------------------------------------------------------------
// Public API — re-exported from provider abstraction layer
// ---------------------------------------------------------------------------

export type { SummarizeOpts, SummarizeResult } from "./_llm-providers/index.ts";
export { summarizeIfLarge } from "./_llm-providers/index.ts";


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

  genome_synthesize:
    "You are consolidating N raw auto-observations about a codebase into a short, curated genome section. Output rules:\n\n" +
    "- If the observations contain NO novel insight (all are restatements of things the genome likely already records — library names, file paths without context, generic boilerplate), output EXACTLY this single line:\n" +
    "  {\"novel\": false, \"reason\": \"<one sentence why>\"}\n\n" +
    "- Otherwise output 1-3 bullet points, each ≤ 200 chars, in plain markdown (no header, no fences). Each bullet must be a genuine insight tied to a concrete file, symbol, decision, or invariant. Deduplicate — if two observations say the same thing, merge them. Skip observations that are pure noise (tool output dumps, test names, generic changelog chatter).\n\n" +
    "- No prose preamble. No 'Here are the bullets:'. Just the bullets (or the novel:false sentinel).",
} as const;
