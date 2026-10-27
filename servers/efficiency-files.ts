/** File reads and immediate edits share one cache and edit summary log. */
import { readFile, writeFile } from "fs/promises";
import { statSync } from "fs";
import { estimateTokensFromString, type Message, snipCompact } from "@ashlr/core-efficiency";
import { refreshGenomeAfterEdit } from "./_genome-live";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { logEvent } from "./_events";
import { recordSaving } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";

// Per-process content cache for ashlr__read. Keyed by absolute path; the
// cached result is only reused when the file's mtimeMs matches - any write
// (ours via ashlr__edit, or external) invalidates. Lives for the MCP server
// lifetime, which aligns with a single Claude Code session.
interface ReadCacheEntry {
  mtimeMs: number;
  /** The exact string we would have returned on a miss. */
  result: string;
  /** Bytes of the original file when cached - for correct savings math on reuse. */
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
    await logEvent("tool_low_confidence_shipped", { tool: "ashlr__read", reason: "low-confidence" });
  }
  const badge = confidenceBadge(badgeOpts);
  const finalTextWithBadge = finalText + badge;

  // Cache the fully computed result for this (path, mtimeMs). Skip caching
  // when bypassSummary was used - that's an opt-out path and shouldn't
  // poison future non-bypass calls.
  if (input.bypassSummary !== true && mtimeMs > 0) {
    readCache.set(abs, { mtimeMs, result: finalTextWithBadge, sourceBytes: content.length });
  }

  return finalTextWithBadge;
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
// ashlr__flush is a "what did I just write?" reporting tool - it returns a
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

  // Treat replacement as literal text. String.prototype.replace(string, string)
  // interprets `$&`, `$1`, `$'`, and `$`` sequences in the replacement.
  const matchIdx = original.indexOf(search);
  const updated = strict
    ? original.slice(0, matchIdx) + replace + original.slice(matchIdx + search.length)
    : original.split(search).join(replace);

  await writeFile(abs, updated, "utf-8");

  // Invalidate read-cache so subsequent ashlr__read calls see new content.
  const hit = readCache.get(abs);
  if (hit) readCache.set(abs, { ...hit, mtimeMs: -1 });

  // best-effort: refreshGenomeAfterEdit already swallows internally; this outer catch guards against a pre-try sync throw so edits never fail because of observability.
  refreshGenomeAfterEdit(abs, original, updated).catch(() => {});

  // v1.18 Trust Pass: baseline is what Claude Code would have SENT for a
  // native Edit - search + replace, NOT the full file twice. The prior
  // `original.length + updated.length` inflated savings 2–5× because it
  // counted the entire file twice even for a one-line change.
  const naiveBytes = search.length + replace.length;
  const compactSummary = summarizeEdit(relPath, search, replace, count, strict);
  await recordSaving(naiveBytes, compactSummary.length, "ashlr__edit");

  const hunksApplied = strict ? 1 : count;
  editLog.push({ relPath, hunksApplied });

  return { text: compactSummary, hunksApplied };
}

const TINY_EDIT_CHARS = 120;

function summarizeEdit(
  relPath: string,
  search: string,
  replace: string,
  matchCount: number,
  strict: boolean,
): string {
  const first = (s: string) => s.split("\n")[0]?.slice(0, 72) ?? "";
  // Tiny edits: the removed/added detail lines cost more than the edit itself,
  // and the caller already knows what it sent. Return the header only.
  if (search.length + replace.length < TINY_EDIT_CHARS) {
    return `[ashlr__edit] ${relPath}  ·  ${strict ? "1 of " + matchCount : matchCount + " of " + matchCount} hunks applied`;
  }
  return [
    `[ashlr__edit] ${relPath}  ·  ${strict ? "1 of " + matchCount : matchCount + " of " + matchCount} hunks applied`,
    `  - removed (${estimateTokensFromString(search)} tok):  ${first(search)}${search.length > 72 ? "…" : ""}`,
    `  + added   (${estimateTokensFromString(replace)} tok):  ${first(replace)}${replace.length > 72 ? "…" : ""}`,
  ].join("\n");
}

