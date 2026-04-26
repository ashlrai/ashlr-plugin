#!/usr/bin/env bun
/**
 * ashlr session-resume — reads ~/.ashlr/session-log.jsonl (+ rotated .1/.2)
 * and produces a compact "pick up where you left off" summary.
 *
 * Exported surface:
 *   buildResume(opts?)  → formatted string, never throws.
 *   SessionSummary      — the data structure for tests to inspect.
 *
 * CLI usage:
 *   bun run scripts/session-resume.ts [<branch>]
 *
 * Limitations:
 *   - The session log records tool names + cwd, NOT individual file paths or
 *     grep patterns. "Files touched" is approximated from read/edit tool call
 *     counts grouped by cwd directory; "patterns" and "bash commands" are
 *     reconstructed from tool-call frequency only (no argument capture).
 *   - Branch detection uses git log timestamps — requires git in PATH and the
 *     cwd to be a git repo at resume time.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { execSync } from "child_process";
import { costFor } from "../servers/_pricing.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface LogRecord {
  ts: string;
  agent?: string;
  event: string;
  tool: string;
  cwd: string;
  session: string;
  input_size: number;
  output_size: number;
  calls?: number;
  tokens_saved?: number;
  started_at?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildResumeOpts {
  /** Override home dir — used by tests. */
  home?: string;
  /** Filter to sessions on this branch (cross-refs via git log timestamps). */
  branch?: string;
  /** Injected now in ms — tests pin this. */
  now?: number;
  /** Max recent sessions to show (default: 1). */
  maxSessions?: number;
  /** Max lines to read per log file (default: unlimited). */
  limitLines?: number;
  /** Git cwd for branch detection (default: process.cwd()). */
  gitCwd?: string;
}

// ---------------------------------------------------------------------------
// Per-session summary data (exported for tests)
// ---------------------------------------------------------------------------

export interface FileStat {
  cwd: string;
  readCalls: number;
  editCalls: number;
  totalCalls: number;
}

export interface ToolCallStat {
  tool: string;
  calls: number;
}

export interface SessionSummary {
  sessionId: string;
  startTs: number;   // ms
  endTs: number;     // ms
  totalCalls: number;
  tokensSaved: number;  // from session_end if present, else 0
  /** Top N cwds touched by read/edit tools, sorted by call count. */
  topFiles: FileStat[];
  /** Top N tools used, sorted by call count — for pattern extraction. */
  topTools: ToolCallStat[];
  /** Top N bash-family tool calls. */
  topBash: ToolCallStat[];
  /** Branch active during session (if detectable). */
  branch?: string;
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set([
  "Read", "ashlr__read", "ashlr__diff", "ashlr__diff_semantic",
  "ashlr__tree", "ashlr__ls", "ashlr__glob",
]);

const EDIT_TOOLS = new Set([
  "Edit", "MultiEdit", "Write",
  "ashlr__edit", "ashlr__multi_edit", "ashlr__edit_structural",
  "ashlr__search_replace_regex", "ashlr__rename_file",
]);

const GREP_TOOLS = new Set([
  "Grep", "ashlr__grep",
]);

const BASH_TOOLS = new Set([
  "Bash", "ashlr__bash", "ashlr__bash_list", "ashlr__bash_start",
  "ashlr__bash_stop", "ashlr__bash_tail",
]);

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

function readLines(path: string, limit?: number): string[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return limit ? lines.slice(0, limit) : lines;
  } catch {
    return [];
  }
}

function parseRecords(lines: string[]): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<LogRecord>;
      if (typeof r.ts !== "string" || typeof r.event !== "string") continue;
      out.push({
        ts: r.ts,
        agent: r.agent ?? "unknown",
        event: r.event,
        tool: r.tool ?? "unknown",
        cwd: r.cwd ?? "",
        session: r.session ?? "",
        input_size: typeof r.input_size === "number" ? r.input_size : 0,
        output_size: typeof r.output_size === "number" ? r.output_size : 0,
        calls: r.calls,
        tokens_saved: r.tokens_saved,
        started_at: r.started_at,
        reason: r.reason,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session grouping
// ---------------------------------------------------------------------------

interface SessionGroup {
  sessionId: string;
  records: LogRecord[];
  sessionEnd?: LogRecord;
}

function groupBySessions(records: LogRecord[]): Map<string, SessionGroup> {
  const groups = new Map<string, SessionGroup>();

  for (const r of records) {
    const sid = r.session || "unknown";
    let g = groups.get(sid);
    if (!g) {
      g = { sessionId: sid, records: [] };
      groups.set(sid, g);
    }
    if (r.event === "session_end") {
      g.sessionEnd = r;
    } else {
      g.records.push(r);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Branch detection via git log
// ---------------------------------------------------------------------------

function detectBranchForTimeRange(
  startMs: number,
  endMs: number,
  cwd: string,
): string | undefined {
  try {
    // Use git log to find the branch that was active around the session time.
    // Strategy: ask git for refs that have commits in the session window.
    const since = new Date(startMs - 300_000).toISOString(); // 5m before
    const until = new Date(endMs + 300_000).toISOString();   // 5m after

    const result = execSync(
      `git log --all --oneline --format="%D" --after="${since}" --before="${until}" 2>/dev/null | head -5`,
      { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

    if (!result) return undefined;

    // Parse "HEAD -> main, origin/main" style refs
    for (const line of result.split("\n")) {
      const headArrow = line.match(/HEAD -> ([^\s,]+)/);
      if (headArrow) return headArrow[1];
      // fallback: first local branch name
      const local = line.match(/(?:^|, )([^\s,/]+\/[^\s,]+|[a-zA-Z][^\s,]*)/);
      if (local && !local[1].startsWith("origin/")) return local[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------

function analyzeSession(
  group: SessionGroup,
  branch?: string,
  gitCwd?: string,
  now?: number,
): SessionSummary {
  const { sessionId, records, sessionEnd } = group;

  // Timestamps
  const timestamps = records
    .map((r) => Date.parse(r.ts))
    .filter(Number.isFinite);

  const startTs = timestamps.length > 0 ? Math.min(...timestamps) : (now ?? Date.now());
  const endTs = timestamps.length > 0 ? Math.max(...timestamps) : startTs;

  // Tokens saved — prefer session_end, else 0
  const tokensSaved = sessionEnd?.tokens_saved ?? 0;

  // Total calls (tool_call events only)
  const toolCalls = records.filter((r) =>
    r.event === "tool_call" || r.event === "tool_escalate" || r.event === "tool_fallback"
  );
  const totalCalls = toolCalls.length;

  // Files touched: group by cwd, count read vs edit calls
  const cwdStats = new Map<string, { read: number; edit: number; grep: number; bash: number }>();
  const toolFreq = new Map<string, number>();
  const bashFreq = new Map<string, number>();

  for (const r of toolCalls) {
    const tool = r.tool;

    // Tool frequency (all tools)
    toolFreq.set(tool, (toolFreq.get(tool) ?? 0) + 1);

    // Bash frequency
    if (BASH_TOOLS.has(tool)) {
      bashFreq.set(tool, (bashFreq.get(tool) ?? 0) + 1);
    }

    // CWD-level file stats
    if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool) || GREP_TOOLS.has(tool)) {
      const cwd = r.cwd || "unknown";
      let s = cwdStats.get(cwd);
      if (!s) {
        s = { read: 0, edit: 0, grep: 0, bash: 0 };
        cwdStats.set(cwd, s);
      }
      if (READ_TOOLS.has(tool)) s.read++;
      else if (EDIT_TOOLS.has(tool)) s.edit++;
      else if (GREP_TOOLS.has(tool)) s.grep++;
    }
  }

  // Top 5 files (cwds) by total call count
  const topFiles: FileStat[] = [...cwdStats.entries()]
    .map(([cwd, s]) => ({
      cwd,
      readCalls: s.read,
      editCalls: s.edit,
      totalCalls: s.read + s.edit + s.grep,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls)
    .slice(0, 5);

  // Top 3 grep/search tools + top N all tools (for "patterns" context)
  const topTools: ToolCallStat[] = [...toolFreq.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  // Top 5 bash tools
  const topBash: ToolCallStat[] = [...bashFreq.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  // Branch detection
  let detectedBranch = branch;
  if (!detectedBranch && gitCwd && timestamps.length > 0) {
    detectedBranch = detectBranchForTimeRange(startTs, endTs, gitCwd);
  }

  return {
    sessionId,
    startTs,
    endTs,
    totalCalls,
    tokensSaved,
    topFiles,
    topTools,
    topBash,
    branch: detectedBranch,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtDurationRelative(ms: number, now: number): string {
  const diffMs = now - ms;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days >= 2) return `${days} days ago`;
  if (days === 1) return "yesterday";
  if (hours >= 1) return `${hours}h ago`;
  if (mins >= 1) return `${mins}m ago`;
  return "just now";
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "< 1m";
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  if (hours >= 1) return `${hours}h ${mins % 60}m`;
  if (mins >= 1) return `${mins}m`;
  return "< 1m";
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
}

function fmtCost(tokens: number): string {
  const dollars = costFor(tokens);
  return `$${dollars.toFixed(2)}`;
}

function shortId(id: string): string {
  if (!id || id.length <= 8) return id || "?";
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderSession(
  summary: SessionSummary,
  now: number,
  index: number,
): string {
  const lines: string[] = [];

  const ago = fmtDurationRelative(summary.startTs, now);
  const dur = fmtDuration(summary.endTs - summary.startTs);
  const tokStr = fmtTokens(summary.tokensSaved);
  const costStr = summary.tokensSaved > 0 ? ` ≈${fmtCost(summary.tokensSaved)}` : "";
  const saved = summary.tokensSaved > 0
    ? ` — saved ${tokStr} tokens${costStr}`
    : "";

  const label = index === 0 ? "Last session" : `Session ${index + 1}`;
  lines.push(`${label} (${ago}, ${dur}${saved}):`);

  if (summary.branch) {
    lines.push(`  Branch:   ${summary.branch}`);
  }

  if (summary.topFiles.length > 0) {
    const first = summary.topFiles[0]!;
    const dirName = basename(first.cwd) || first.cwd;
    lines.push(
      `  Work dir: ${dirName}  (${first.readCalls} reads, ${first.editCalls} edits)`,
    );
    for (const f of summary.topFiles.slice(1)) {
      const d = basename(f.cwd) || f.cwd;
      lines.push(
        `            ${d}  (${f.readCalls} reads, ${f.editCalls} edits)`,
      );
    }
  } else {
    lines.push("  Work dir: (not recorded)");
  }

  // Tool patterns: highlight grep, search, read calls
  const searchTools = summary.topTools.filter((t) => GREP_TOOLS.has(t.tool));
  if (searchTools.length > 0) {
    const top3 = searchTools.slice(0, 3);
    lines.push(`  Patterns: ${top3.map((t) => `${t.tool} ×${t.calls}`).join(", ")}`);
  }

  // Bash calls
  if (summary.topBash.length > 0) {
    const top5 = summary.topBash.slice(0, 5);
    lines.push(`  Bash:     ${top5.map((t) => `${t.tool} ×${t.calls}`).join(", ")}`);
  }

  lines.push(`  Calls:    ${summary.totalCalls} tool invocations`);

  return lines.join("\n");
}

function renderSuggestions(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Resume? Suggested next steps based on the trail:");

  if (summary.topFiles.length > 0) {
    const top = summary.topFiles[0]!;
    const dirName = basename(top.cwd) || top.cwd;
    if (top.editCalls > 0) {
      lines.push(`  - Re-open ${dirName} (last edits in this session)`);
    } else {
      lines.push(`  - Review ${dirName} (most activity in this session)`);
    }
  }

  if (summary.topBash.length > 0) {
    const topBash = summary.topBash[0]!;
    lines.push(`  - Re-run: ${topBash.tool} (used ×${topBash.calls} last session)`);
  }

  if (summary.branch) {
    lines.push(`  - Continue on branch: ${summary.branch}`);
  }

  if (lines.length === 2) {
    // Only the header was added
    lines.push("  - Check git status and recent commits to orient");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Branch filter: match sessions whose timestamp range overlaps a git branch
// ---------------------------------------------------------------------------

function getGitBranchCommitRange(
  branch: string,
  gitCwd: string,
): { earliest: number; latest: number } | undefined {
  try {
    const result = execSync(
      `git log "${branch}" --format="%ci" --max-count=50 2>/dev/null`,
      { cwd: gitCwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

    if (!result) return undefined;

    const timestamps = result
      .split("\n")
      .map((l) => Date.parse(l.trim()))
      .filter(Number.isFinite);

    if (timestamps.length === 0) return undefined;

    return {
      earliest: Math.min(...timestamps),
      latest: Math.max(...timestamps),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildResume(opts: BuildResumeOpts = {}): string {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const maxSessions = opts.maxSessions ?? 1;
  const gitCwd = opts.gitCwd ?? process.cwd();

  const logPath = join(home, ".ashlr", "session-log.jsonl");
  const rotated1 = logPath + ".1";
  const rotated2 = logPath + ".2";

  const lines1 = readLines(rotated2, opts.limitLines);
  const lines2 = readLines(rotated1, opts.limitLines);
  const lines3 = readLines(logPath, opts.limitLines);
  const allLines = [...lines1, ...lines2, ...lines3];

  if (allLines.length === 0) {
    return [
      "No prior sessions found — you're starting fresh.",
      "",
      "Once you use ashlr__read, ashlr__grep, or ashlr__edit, activity will",
      `be recorded to: ${logPath}`,
    ].join("\n");
  }

  const records = parseRecords(allLines);
  const groups = groupBySessions(records);

  if (groups.size === 0) {
    return "No prior sessions found — you're starting fresh.";
  }

  // Compute summaries, sorted by most recent first
  let summaries: SessionSummary[] = [...groups.values()]
    .map((g) => analyzeSession(g, undefined, gitCwd, now))
    .filter((s) => s.totalCalls > 0)
    .sort((a, b) => b.endTs - a.endTs);

  if (summaries.length === 0) {
    return "No activity recorded yet — you're starting fresh.";
  }

  // Branch filter
  if (opts.branch) {
    const range = getGitBranchCommitRange(opts.branch, gitCwd);
    if (range) {
      const branchSummaries = summaries.filter(
        (s) => s.startTs <= range.latest + 24 * 60 * 60_000 &&
               s.endTs >= range.earliest - 24 * 60 * 60_000,
      );
      if (branchSummaries.length > 0) {
        summaries = branchSummaries.map((s) => ({ ...s, branch: opts.branch }));
      } else {
        // No sessions match the branch — fall back to most recent with a note
        summaries = summaries.slice(0, maxSessions);
        const parts = summaries
          .map((s, i) => renderSession(s, now, i))
          .join("\n\n");
        return [
          `No sessions found on branch "${opts.branch}".`,
          "Showing most recent session instead:",
          "",
          parts,
          renderSuggestions(summaries[0]!),
        ].join("\n");
      }
    } else {
      // Can't determine branch range — tag matching sessions with branch name
      summaries = summaries.slice(0, maxSessions).map((s) => ({
        ...s,
        branch: opts.branch,
      }));
    }
  }

  const toShow = summaries.slice(0, maxSessions);
  const parts = toShow.map((s, i) => renderSession(s, now, i)).join("\n\n");
  const suggestions = renderSuggestions(toShow[0]!);

  return [parts, suggestions].join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const branch = process.argv[2]; // optional branch arg
    process.stdout.write(buildResume({ branch }) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`session-resume failed: ${msg}\n`);
  }
  process.exit(0);
}
