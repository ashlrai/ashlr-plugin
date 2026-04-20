#!/usr/bin/env bun
/**
 * ashlr-diff-semantic MCP server.
 *
 * Exposes ashlr__diff_semantic — AST-aware (heuristic) diff summarization.
 * A 200-line rename-refactor across 20 files renders as one line.
 *
 * Semantic analysis passes (in order, applied to each file's hunks):
 *   1. Rename detection   — if symbol X appears in deletions and Y appears at
 *      the same position in additions across >= 3 files, emit
 *      "renamed X -> Y (N occurrences across K files)"
 *   2. Signature change   — function/method declaration line changed but body
 *      lines are identical
 *   3. Formatting-only    — diff reduces to whitespace changes only
 *   4. Other              — falls through to a compact summary (same output
 *      as ashlr__diff summary mode)
 *
 * Savings are persisted to the shared ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { recordSaving as recordSavingCore } from "./_stats";
import { summarizeIfLarge, PROMPTS } from "./_summarize";

// ---------------------------------------------------------------------------
// Savings wrapper
// ---------------------------------------------------------------------------

async function recordSaving(rawBytes: number, compactBytes: number): Promise<number> {
  return recordSavingCore(rawBytes, compactBytes, "ashlr__diff_semantic");
}

// ---------------------------------------------------------------------------
// Git helpers (mirrors diff-server.ts — no shared dependency to keep servers
// standalone)
// ---------------------------------------------------------------------------

function runGit(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: 15_000,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function isGitRepo(cwd: string): boolean {
  const r = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface SemanticDiffArgs {
  /** Skip LLM summarization of long semantic-diff output. */
  bypassSummary?: boolean;
  cwd?: string;
  range?: string;
  staged?: boolean;
}

function buildGitDiffArgs(args: SemanticDiffArgs): string[] {
  if (args.staged) return ["--cached"];
  if (args.range) return [args.range];
  // Default: unstaged working tree
  return [];
}

// ---------------------------------------------------------------------------
// Diff splitting
// ---------------------------------------------------------------------------

interface FileDiff {
  path: string;
  raw: string;
  hunks: Hunk[];
}

interface Hunk {
  header: string;
  lines: string[]; // raw diff lines (+ / - / context), excluding hunk header
}

function splitDiffIntoFiles(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (!raw.trim()) return files;

  const parts = raw.split(/^diff --git /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const firstLine = part.split("\n", 1)[0] ?? "";
    const m = firstLine.match(/ b\/(.+)$/);
    const path = m ? m[1]! : firstLine.trim();
    const block = "diff --git " + part;
    files.push({ path, raw: block, hunks: parseHunks(block) });
  }
  return files;
}

function parseHunks(fileBlock: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = fileBlock.split("\n");
  let cur: Hunk | null = null;
  for (const ln of lines) {
    if (ln.startsWith("@@")) {
      if (cur) hunks.push(cur);
      cur = { header: ln, lines: [] };
    } else if (cur) {
      cur.lines.push(ln);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// ---------------------------------------------------------------------------
// Heuristic analysis
// ---------------------------------------------------------------------------

// -- 1. Formatting-only detection -------------------------------------------

/**
 * Returns true when every changed line (+ or -) is identical after stripping
 * all whitespace — i.e. the diff is purely a reformatting.
 */
function isFormattingOnly(hunks: Hunk[]): boolean {
  if (hunks.length === 0) return false;
  const added: string[] = [];
  const deleted: string[] = [];
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (ln.startsWith("+") && !ln.startsWith("+++")) {
        added.push(ln.slice(1).replace(/\s/g, ""));
      } else if (ln.startsWith("-") && !ln.startsWith("---")) {
        deleted.push(ln.slice(1).replace(/\s/g, ""));
      }
    }
  }
  if (added.length === 0 && deleted.length === 0) return false;
  if (added.length !== deleted.length) return false;
  for (let i = 0; i < added.length; i++) {
    if (added[i] !== deleted[i]) return false;
  }
  return true;
}

// -- 2. Signature-change detection ------------------------------------------

// Patterns that identify function/method/class declaration lines.
const DECL_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+\w|class\s+\w|\w+\s*[=:]\s*(async\s+)?\(|def\s+\w|fn\s+\w|func\s+\w|public\s+|private\s+|protected\s+|static\s+)/;

interface SignatureChange {
  file: string;
  from: string;
  to: string;
}

function detectSignatureChanges(files: FileDiff[]): SignatureChange[] {
  const changes: SignatureChange[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      const dels = hunk.lines.filter(
        (l) => l.startsWith("-") && !l.startsWith("---"),
      );
      const adds = hunk.lines.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++"),
      );
      if (dels.length !== adds.length) continue;
      // All deleted lines must be declaration lines; body lines must match
      for (let i = 0; i < dels.length; i++) {
        const delLine = dels[i]!.slice(1);
        const addLine = adds[i]!.slice(1);
        if (!DECL_RE.test(delLine) && !DECL_RE.test(addLine)) continue;
        if (delLine.replace(/\s/g, "") === addLine.replace(/\s/g, "")) continue;
        // Check context (non-+/- lines) are purely body — no extra changes
        const contextLines = hunk.lines.filter(
          (l) => !l.startsWith("+") && !l.startsWith("-"),
        );
        const changedLines = hunk.lines.filter(
          (l) =>
            (l.startsWith("+") && !l.startsWith("+++")) ||
            (l.startsWith("-") && !l.startsWith("---")),
        );
        // Signature-only: only one pair of changed lines per hunk, rest is context
        if (changedLines.length === 2 && contextLines.length > 0) {
          changes.push({
            file: file.path,
            from: delLine.trim(),
            to: addLine.trim(),
          });
        }
      }
    }
  }
  return changes;
}

// -- 3. Rename detection -----------------------------------------------------

/**
 * Rename detection heuristic:
 *
 * For each hunk, extract deleted tokens and added tokens (identifiers only —
 * [A-Za-z_][A-Za-z0-9_]*). Build a positional diff: for each position i,
 * if deleted[i] != added[i], record the pair (deleted[i], added[i]).
 *
 * Then, across ALL files, if the same (from, to) pair appears in >= 3 files,
 * it's considered a rename. We pick the most-frequent pair and emit it.
 *
 * False-positive scenarios addressed:
 *   - Common English words / short tokens (< 3 chars) are skipped.
 *   - Pairs where `from === to` are ignored (no-op).
 *   - We require >= 3 *files* (not just occurrences) to call it a rename.
 *   - A single giant churn that replaces many unrelated tokens won't fire
 *     because positional matching limits scope to tokens at the same index.
 */

interface RenameCandidate {
  from: string;
  to: string;
  files: Set<string>;
  occurrences: number;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const MIN_TOKEN_LEN = 3;
const MIN_FILES_FOR_RENAME = 3;

function extractTokens(line: string): string[] {
  return Array.from(line.matchAll(IDENT_RE), (m) => m[0]).filter(
    (t) => t.length >= MIN_TOKEN_LEN,
  );
}

function detectRenames(files: FileDiff[]): RenameCandidate[] {
  // Map: `${from}\0${to}` -> { from, to, files, occurrences }
  const pairMap = new Map<string, RenameCandidate>();

  for (const file of files) {
    // Track pairs seen in this file to avoid double-counting per-file
    const filePairs = new Set<string>();

    for (const hunk of file.hunks) {
      const delLines = hunk.lines.filter(
        (l) => l.startsWith("-") && !l.startsWith("---"),
      );
      const addLines = hunk.lines.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++"),
      );

      // Only process hunks where line counts match (substitutions, not pure insertions/deletions)
      if (delLines.length === 0 || addLines.length === 0) continue;
      const pairCount = Math.min(delLines.length, addLines.length);

      for (let i = 0; i < pairCount; i++) {
        const delTokens = extractTokens(delLines[i]!.slice(1));
        const addTokens = extractTokens(addLines[i]!.slice(1));

        // Positional matching: same index, different token
        const limit = Math.min(delTokens.length, addTokens.length);
        for (let j = 0; j < limit; j++) {
          const from = delTokens[j]!;
          const to = addTokens[j]!;
          if (from === to) continue;
          const key = `${from}\0${to}`;
          filePairs.add(key);
        }
      }
    }

    // Now credit each unique pair to this file
    for (const key of filePairs) {
      const [from, to] = key.split("\0") as [string, string];
      let entry = pairMap.get(key);
      if (!entry) {
        entry = { from, to, files: new Set(), occurrences: 0 };
        pairMap.set(key, entry);
      }
      entry.files.add(file.path);
      entry.occurrences++;
    }
  }

  // Filter: must appear in >= MIN_FILES_FOR_RENAME distinct files
  return Array.from(pairMap.values())
    .filter((c) => c.files.size >= MIN_FILES_FOR_RENAME)
    .sort((a, b) => b.files.size - a.files.size || b.occurrences - a.occurrences);
}

// ---------------------------------------------------------------------------
// Numstat helpers (for footer)
// ---------------------------------------------------------------------------

interface FileStat {
  added: number;
  deleted: number;
  path: string;
}

function parseNumstat(raw: string): FileStat[] {
  const out: FileStat[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    out.push({
      added: a === "-" ? 0 : Number(a) || 0,
      deleted: d === "-" ? 0 : Number(d) || 0,
      path: rest.join("\t"),
    });
  }
  return out;
}

function fmtKB(bytes: number): string {
  return (bytes / 1024).toFixed(1) + " KB";
}

// ---------------------------------------------------------------------------
// Compact fallback summary (mirrors diff-server.ts summary mode logic)
// ---------------------------------------------------------------------------

function compactSummary(files: FileStat[], rawDiff: string): string {
  if (files.length === 0) return "(no changes)";
  const totalAdd = files.reduce((s, f) => s + f.added, 0);
  const totalDel = files.reduce((s, f) => s + f.deleted, 0);
  const lines: string[] = [
    `${files.length} file${files.length === 1 ? "" : "s"} changed · +${totalAdd} -${totalDel} lines`,
  ];
  // Show up to 5 files with their line counts
  for (const f of files.slice(0, 5)) {
    lines.push(`  ${f.path}  +${f.added} -${f.deleted}`);
  }
  if (files.length > 5) lines.push(`  ... and ${files.length - 5} more file(s)`);
  void rawDiff;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main semantic analysis
// ---------------------------------------------------------------------------

export async function ashlrDiffSemantic(args: SemanticDiffArgs): Promise<string> {
  const cwd = args.cwd ?? process.cwd();
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!isGitRepo(cwd)) throw new Error(`not a git repository: ${cwd}`);

  const diffArgs = buildGitDiffArgs(args);

  // Raw diff — what Claude Code would have read without us
  const rawResult = runGit(cwd, ["diff", ...diffArgs]);
  if (!rawResult.ok) {
    throw new Error(`git diff failed: ${rawResult.stderr.trim() || "unknown error"}`);
  }
  const rawDiff = rawResult.stdout;
  const rawBytes = Buffer.byteLength(rawDiff, "utf-8");

  // Numstat for summary fallback and footer
  const numstatResult = runGit(cwd, ["diff", "--numstat", ...diffArgs]);
  const fileStats = numstatResult.ok ? parseNumstat(numstatResult.stdout) : [];

  // Parse diff into per-file structures
  const fileDiffs = splitDiffIntoFiles(rawDiff);

  // -- Analysis passes -------------------------------------------------------

  const formattingFiles: string[] = [];
  const otherFiles: FileStat[] = [];

  for (const fd of fileDiffs) {
    if (isFormattingOnly(fd.hunks)) {
      formattingFiles.push(fd.path);
    }
  }

  // Files that are NOT formatting-only go through other passes
  const nonFormattingDiffs = fileDiffs.filter(
    (fd) => !formattingFiles.includes(fd.path),
  );

  const renames = detectRenames(nonFormattingDiffs);
  const sigChanges = detectSignatureChanges(nonFormattingDiffs);

  // Build the set of files "explained" by rename/signature analysis
  const explainedPaths = new Set<string>();
  for (const r of renames) {
    for (const p of r.files) explainedPaths.add(p);
  }
  for (const s of sigChanges) {
    explainedPaths.add(s.file);
  }

  // Remaining files with actual changes not explained above
  for (const fs of fileStats) {
    if (!formattingFiles.includes(fs.path) && !explainedPaths.has(fs.path)) {
      otherFiles.push(fs);
    }
  }

  const hasSemanticContent =
    renames.length > 0 ||
    sigChanges.length > 0 ||
    formattingFiles.length > 0;

  // -- Render output ---------------------------------------------------------

  const sections: string[] = [];

  if (renames.length > 0) {
    const lines: string[] = [`renames: ${renames.length} detected`];
    for (const r of renames) {
      lines.push(
        `  ${r.from} -> ${r.to}  (${r.occurrences} occurrence${r.occurrences === 1 ? "" : "s"} across ${r.files.size} file${r.files.size === 1 ? "" : "s"})`,
      );
    }
    sections.push(lines.join("\n"));
  }

  if (sigChanges.length > 0) {
    const lines: string[] = [`signature changes: ${sigChanges.length}`];
    for (const sc of sigChanges) {
      // Truncate long signatures for compactness
      const fromShort =
        sc.from.length > 80 ? sc.from.slice(0, 77) + "..." : sc.from;
      const toShort = sc.to.length > 80 ? sc.to.slice(0, 77) + "..." : sc.to;
      lines.push(`  ${sc.file}: ${fromShort} -> ${toShort}`);
    }
    sections.push(lines.join("\n"));
  }

  if (formattingFiles.length > 0) {
    sections.push(
      `formatting-only: ${formattingFiles.length} file${formattingFiles.length === 1 ? "" : "s"}\n` +
        formattingFiles.map((f) => `  ${f}`).join("\n"),
    );
  }

  let body: string;

  if (!hasSemanticContent || otherFiles.length > 0) {
    const otherSummary =
      otherFiles.length > 0 ? compactSummary(otherFiles, rawDiff) : null;

    if (!hasSemanticContent) {
      // Full degradation: behave exactly like ashlr__diff compact output
      body = compactSummary(fileStats, rawDiff);
    } else {
      // Mixed: semantic sections + compact summary for remainder
      if (otherSummary) sections.push(`other changes:\n${otherSummary}`);
      body = sections.join("\n\n");
    }
  } else {
    body = sections.join("\n\n");
  }

  // -- Footer ----------------------------------------------------------------

  const compactBytes = Buffer.byteLength(body, "utf-8");
  const footerRaw = fmtKB(rawBytes);
  const footerCompact = fmtKB(compactBytes);
  const footer = `\n\n[ashlr__diff_semantic] raw: ${footerRaw} · compact: ${footerCompact} · ${renames.length} rename${renames.length === 1 ? "" : "s"} detected`;

  const fullOutput = body + footer;

  // Pipe large semantic-diff output through the shared LLM summarizer so a
  // 300-file refactor doesn't hand Claude 40KB of rename rows. Opt out via
  // bypassSummary so tests and power users can still see the raw body.
  const DIFF_SEMANTIC_LLM_THRESHOLD = 8 * 1024;
  const summResult = await summarizeIfLarge(fullOutput, {
    toolName: "ashlr__diff_semantic",
    systemPrompt: PROMPTS.diff_semantic,
    thresholdBytes: DIFF_SEMANTIC_LLM_THRESHOLD,
    bypass: args.bypassSummary === true,
  });
  const outputText = summResult.text;

  await recordSaving(rawBytes, Buffer.byteLength(outputText, "utf-8"));

  return outputText;
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-diff-semantic", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__diff_semantic",
      description:
        "AST-aware (heuristic) git diff summarization. A 200-line rename-refactor across 20 files renders as one line. Detects: symbol renames across >= 3 files, signature-only changes, formatting-only diffs. Degrades gracefully to compact diff output when no semantic patterns are found. Use instead of ashlr__diff when reviewing refactors, renames, or large reformatting commits.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
          range: {
            type: "string",
            description:
              "Git range to diff, e.g. 'HEAD~1..HEAD'. Default: unstaged working tree changes.",
          },
          staged: {
            type: "boolean",
            description: "If true, diff staged changes (--cached). Overrides range.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__diff_semantic") {
      const text = await ashlrDiffSemantic((args ?? {}) as SemanticDiffArgs);
      return { content: [{ type: "text", text }] };
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `ashlr__diff_semantic error: ${message}` }],
      isError: true,
    };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
