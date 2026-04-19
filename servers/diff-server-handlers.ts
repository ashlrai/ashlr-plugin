/**
 * diff-server-handlers — side-effect module.
 *
 * Importing this file registers the ashlr__diff tool into the shared registry
 * (_tool-base.ts). Used by both the standalone entry point (diff-server.ts)
 * and the router (_router.ts via _router-handlers.ts).
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { recordSaving as recordSavingCore } from "./_stats";
import { logEvent } from "./_events";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// snipCompact for full-mode oversized diffs
// ---------------------------------------------------------------------------

const FULL_SNIP_THRESHOLD = 4096;
const HEAD_BYTES = 1600;
const TAIL_BYTES = 1600;

function snipCompact(s: string): string {
  if (s.length <= FULL_SNIP_THRESHOLD) return s;
  const elided = s.length - HEAD_BYTES - TAIL_BYTES;
  return (
    s.slice(0, HEAD_BYTES) +
    `\n[... ${elided.toLocaleString()} bytes of diff elided ...]\n` +
    s.slice(-TAIL_BYTES)
  );
}

// ---------------------------------------------------------------------------
// git invocation
// ---------------------------------------------------------------------------

interface DiffArgs {
  ref?: string;
  path?: string;
  cwd?: string;
  mode?: "stat" | "summary" | "full";
  bypassSummary?: boolean;
}

function resolveRefArgs(ref: string): { args: string[]; label: string } {
  const r = ref.trim();
  if (r === "staged" || r === "--cached" || r === "cached") {
    return { args: ["--cached"], label: "staged" };
  }
  if (r === "unstaged" || r === "working") {
    return { args: [], label: r };
  }
  return { args: [r], label: r };
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
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
// numstat + hunk parsing
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
    const path = rest.join("\t");
    const added = a === "-" ? 0 : Number(a) || 0;
    const deleted = d === "-" ? 0 : Number(d) || 0;
    out.push({ added, deleted, path });
  }
  return out;
}

function padCol(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + " ".repeat(w - s.length);
}

function renderStat(files: FileStat[], header: string): string {
  const totalAdd = files.reduce((s, f) => s + f.added, 0);
  const totalDel = files.reduce((s, f) => s + f.deleted, 0);
  const lines: string[] = [
    `diff ${header} \u00b7 ${files.length} file${files.length === 1 ? "" : "s"} \u00b7 +${totalAdd} -${totalDel} lines`,
  ];
  if (files.length === 0) return lines[0]! + "\n  (no changes)";
  const pathW = Math.min(60, Math.max(...files.map((f) => f.path.length)));
  for (const f of files) {
    lines.push(`  ${padCol(f.path, pathW)}  +${f.added} -${f.deleted}`);
  }
  return lines.join("\n");
}

interface Hunk {
  header: string;
  added: string[];
  deletedCount: number;
  addedCountTotal: number;
}

function parseHunksForFile(fileBlock: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = fileBlock.split("\n");
  let cur: Hunk | null = null;
  for (const ln of lines) {
    if (ln.startsWith("@@")) {
      if (cur) hunks.push(cur);
      cur = { header: ln, added: [], deletedCount: 0, addedCountTotal: 0 };
    } else if (cur) {
      if (ln.startsWith("+") && !ln.startsWith("+++")) {
        cur.addedCountTotal++;
        cur.added.push(ln);
      } else if (ln.startsWith("-") && !ln.startsWith("---")) {
        cur.deletedCount++;
      }
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

function splitDiffByFile(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  const parts = raw.split(/^diff --git /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const firstLine = part.split("\n", 1)[0] || "";
    const m = firstLine.match(/ b\/(.+)$/);
    const path = m ? m[1]! : firstLine.trim();
    map.set(path, "diff --git " + part);
  }
  return map;
}

function renderSummary(files: FileStat[], header: string, rawDiff: string): string {
  const stat = renderStat(files, header);
  const blocks = splitDiffByFile(rawDiff);
  const out: string[] = [stat, ""];
  const KEY_ADDED_SHOWN = 10;
  for (const f of files) {
    const block = blocks.get(f.path);
    out.push(`${f.path}  +${f.added} -${f.deleted}`);
    if (!block) {
      out.push("  (no hunks)");
      out.push("");
      continue;
    }
    const hunks = parseHunksForFile(block);
    const hottest = [...hunks].sort((a, b) => b.addedCountTotal - a.addedCountTotal).slice(0, 2);
    if (hottest.length === 0) {
      out.push("  (no hunks)");
    }
    for (const h of hottest) {
      out.push(`  ${h.header}`);
      const shown = h.added.slice(0, KEY_ADDED_SHOWN);
      for (const s of shown) {
        out.push(`    ${s}`);
      }
      const moreAdded = Math.max(0, h.addedCountTotal - shown.length);
      if (moreAdded > 0 || h.deletedCount > 0) {
        out.push(`    [... ${moreAdded} more added \u00b7 ${h.deletedCount} deleted ...]`);
      }
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

export async function ashlrDiff(args: DiffArgs): Promise<string> {
  const clamp = clampToCwd(args.cwd, "ashlr__diff");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;
  if (!existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  if (!isGitRepo(cwd)) {
    throw new Error(`not a git repository: ${cwd}`);
  }

  const refIn = args.ref ?? "HEAD~1";
  const { args: refArgs, label } = resolveRefArgs(refIn);
  const pathArgs = args.path ? ["--", args.path] : [];

  const numstat = runGit(cwd, ["diff", "--numstat", ...refArgs, ...pathArgs]);
  if (!numstat.ok) {
    const msg = numstat.stderr.trim() || "git diff failed";
    throw new Error(`git diff failed: ${msg}`);
  }
  const files = parseNumstat(numstat.stdout);
  const totalChangedLines = files.reduce((s, f) => s + f.added + f.deleted, 0);

  const raw = runGit(cwd, ["diff", ...refArgs, ...pathArgs]);
  const rawDiff = raw.ok ? raw.stdout : "";
  const rawBytes = rawDiff.length;

  let mode: "stat" | "summary" | "full";
  if (args.mode === "stat" || args.mode === "summary" || args.mode === "full") {
    mode = args.mode;
  } else if (totalChangedLines > 500) {
    mode = "stat";
  } else if (totalChangedLines >= 100) {
    mode = "summary";
  } else {
    mode = "full";
  }

  let body: string;
  if (mode === "stat") {
    body = renderStat(files, label);
  } else if (mode === "summary") {
    body = renderSummary(files, label, rawDiff);
  } else {
    if (!rawDiff) {
      body = renderStat(files, label);
    } else {
      const header = renderStat(files, label);
      body = `${header}\n\n${snipCompact(rawDiff)}`;
    }
  }

  const rawDiffBytes = Buffer.byteLength(rawDiff, "utf-8");
  if ((mode === "full" || mode === "summary") && rawDiffBytes > 16_384 && !args.bypassSummary) {
    const s = await summarizeIfLarge(body, {
      toolName: "ashlr__diff",
      systemPrompt: PROMPTS.diff,
      bypass: false,
      thresholdBytes: 1,
    });
    body = s.text;
  }

  const footer = `\n\n[ashlr__diff \u00b7 mode=${mode}]`;
  const text = body + footer;

  const diffRawBytes = Math.max(rawBytes, body.length);
  await recordSavingCore(diffRawBytes, text.length, "ashlr__diff");

  const diffBadgeOpts = {
    toolName: "ashlr__diff",
    rawBytes: diffRawBytes,
    outputBytes: text.length,
  };
  if (confidenceTier(diffBadgeOpts) === "low") {
    await logEvent("tool_noop", { tool: "ashlr__diff", reason: "low-confidence" });
  }
  return text + confidenceBadge(diffBadgeOpts);
}

// ---------------------------------------------------------------------------
// Registration (side-effect on import)
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__diff",
  description:
    "Token-efficient git diff. Adaptive by default: returns stat-only when a diff is huge (>500 changed lines), a stat + hottest-hunks summary when moderate (100-500), or the full patch when small (<100). Accepts any git ref plus the pseudo-refs 'staged', 'unstaged', 'working'. Replaces `git diff | cat` which often dumps thousands of lines into the context.",
  inputSchema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description:
          "Git ref to diff against (default: HEAD~1). Also accepts 'staged' / 'unstaged' / 'working'.",
      },
      path: { type: "string", description: "Limit to path(s) \u2014 file or dir" },
      cwd: { type: "string" },
      mode: {
        type: "string",
        description:
          "'stat' (files + lines only) \u00b7 'summary' (stat + hottest hunks) \u00b7 'full' (default: adaptive \u2014 stat if huge, summary if moderate, full if small)",
      },
      bypassSummary: {
        type: "boolean",
        description: "If true, skip LLM summarization and return the full compacted diff.",
      },
    },
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrDiff(args as unknown as DiffArgs);
    return { content: [{ type: "text", text }] };
  },
});
