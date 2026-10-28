#!/usr/bin/env bun
/**
 * subagent-stop-rollup.ts — SubagentStop hook.
 *
 * When a subagent finishes:
 *   1. Reads stdin payload for Claude task_id/subagent_session_id or Codex
 *      agent_id/session_id.
 *   2. Appends a rollup line to ~/.ashlr/session-log.jsonl (unless
 *      ASHLR_SESSION_LOG=0). Idempotent per task_id/agent_id: a repeated stop
 *      for the same subagent adds no new line, and duplicate subagent_stop
 *      lines already in the log are collapsed (first occurrence kept).
 *   3. Fire-and-forget genome consolidation for the cwd (unless ASHLR_GENOME_AUTO=0).
 *
 * SubagentStop is a decision-control event: it does NOT support
 * hookSpecificOutput / additionalContext, so this hook only does its side
 * effects and exits silently.
 *
 * Contract: never throws, always exits 0.
 *
 * Env toggles:
 *   ASHLR_SESSION_LOG=0   — skip appending to session-log.jsonl
 *   ASHLR_GENOME_AUTO=0   — skip genome consolidation
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

import { noteHookError } from "./_hook-errors";

interface SubagentStopPayload {
  task_id?: string;
  subagent_session_id?: string;
  agent_id?: string;
  agent_type?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface RollupLine {
  ts: string;
  event: "subagent_stop";
  task_id: string | null;
  subagent_session_id: string | null;
  agent_id?: string | null;
  agent_type?: string | null;
  tokens_saved: number;
  calls: number;
  top_tool: string | null;
}

export interface SubagentSummary {
  tokensSaved: number;
  calls: number;
  topTool: string | null;
}

export interface AppendRollupResult {
  /** True when a new line was written; false when the stop was already logged. */
  appended: boolean;
  /** Number of duplicate subagent_stop lines removed from the existing log. */
  removed: number;
}

/**
 * Identity used to dedupe subagent_stop lines: task_id first (Claude), then
 * agent_id (Codex), then subagent_session_id as a last resort. Non-string or
 * missing values are skipped; lines with no usable identifier are never
 * deduped because we cannot tell them apart.
 */
export function subagentStopKey(entry: {
  task_id?: unknown;
  agent_id?: unknown;
  subagent_session_id?: unknown;
}): string | null {
  for (const v of [entry.task_id, entry.agent_id, entry.subagent_session_id]) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Key of a raw JSONL line, or null for non-subagent_stop events, malformed
 * JSON, and subagent_stop lines without an identifier.
 */
function subagentStopLineKey(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as {
      event?: unknown;
      task_id?: unknown;
      agent_id?: unknown;
      subagent_session_id?: unknown;
    };
    if (parsed.event !== "subagent_stop") return null;
    return subagentStopKey(parsed);
  } catch {
    return null;
  }
}

/**
 * Collapse repeated subagent_stop lines: keep the first line per identity
 * (task_id / agent_id / subagent_session_id), drop later repeats. Every other
 * line — other events, malformed JSON — is preserved verbatim and in order.
 */
export function dedupeSubagentStopLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = subagentStopLineKey(line);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(line);
  }
  return kept;
}

/**
 * Idempotently record a rollup line in session-log.jsonl:
 *   - reads the existing log and collapses any duplicate subagent_stop lines
 *     already present (first occurrence per identity wins),
 *   - appends `line` only when no subagent_stop entry with the same identity
 *     exists yet.
 * The common path is a single append; the file is rewritten (tmp + rename)
 * only when dedupe actually removed lines.
 */
export async function appendRollupLine(
  logPath: string,
  line: RollupLine,
): Promise<AppendRollupResult> {
  const serialized = JSON.stringify(line);
  const key = subagentStopKey(line);

  await mkdir(dirname(logPath), { recursive: true });

  let existing: string[] = [];
  try {
    existing = (await readFile(logPath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch { /* no log yet */ }

  const deduped = dedupeSubagentStopLines(existing);
  const removed = existing.length - deduped.length;
  const already = key !== null && deduped.some((l) => subagentStopLineKey(l) === key);

  if (removed === 0) {
    if (already) return { appended: false, removed: 0 };
    await appendFile(logPath, serialized + "\n", "utf-8");
    return { appended: true, removed: 0 };
  }

  if (!already) deduped.push(serialized);
  const tmp = `${logPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, deduped.join("\n") + "\n", "utf-8");
  await rename(tmp, logPath);
  return { appended: !already, removed };
}

/** Build the JSONL rollup line for a finished subagent. */
export function buildRollupLine(opts: {
  taskId: string | null;
  subagentSessionId: string | null;
  agentId?: string | null;
  agentType?: string | null;
  summary: SubagentSummary;
  ts?: string;
}): RollupLine {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    event: "subagent_stop",
    task_id: opts.taskId,
    subagent_session_id: opts.subagentSessionId,
    agent_id: opts.agentId ?? null,
    agent_type: opts.agentType ?? null,
    tokens_saved: opts.summary.tokensSaved,
    calls: opts.summary.calls,
    top_tool: opts.summary.topTool,
  };
}

/** Read and parse stdin with a 200ms timeout. Returns {} on failure. */
async function readStdinPayload(): Promise<SubagentStopPayload> {
  try {
    if (process.stdin.isTTY) return {};
    const chunks: Buffer[] = [];
    await Promise.race([
      (async () => {
        for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
      })(),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as SubagentStopPayload;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  try {
    const payload = await readStdinPayload();
    const taskId = payload.task_id ?? payload.agent_id ?? null;
    const subagentSessionId = payload.subagent_session_id ?? payload.session_id ?? null;
    const agentId = payload.agent_id ?? null;
    const agentType = payload.agent_type ?? null;

    // Read subagent session stats.
    let summary: SubagentSummary = { tokensSaved: 0, calls: 0, topTool: null };
    try {
      const statsPath = join(
        process.env.CLAUDE_PLUGIN_ROOT ?? process.env.CODEX_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), ".."),
        "servers",
        "_stats",
      );
      const { readCurrentSession } = await import(statsPath) as {
        readCurrentSession: (id?: string) => Promise<{ tokensSaved: number; calls: number; byTool: Record<string, { calls: number }> }>;
      };
      const sess = await readCurrentSession(subagentSessionId ?? undefined);
      let topTool: string | null = null;
      let topCalls = 0;
      for (const [tool, pt] of Object.entries(sess.byTool ?? {})) {
        if (pt.calls > topCalls) { topCalls = pt.calls; topTool = tool; }
      }
      summary = { tokensSaved: sess.tokensSaved, calls: sess.calls, topTool };
    } catch { /* best-effort */ }

    // 1. Append rollup line to session-log.jsonl (idempotent per task/agent).
    if (process.env.ASHLR_SESSION_LOG !== "0") {
      try {
        const logPath = join(process.env.HOME ?? homedir(), ".ashlr", "session-log.jsonl");
        const line = buildRollupLine({ taskId, subagentSessionId, agentId, agentType, summary });
        await appendRollupLine(logPath, line);
      } catch (e) {
        noteHookError("subagent-stop-rollup", "append-log", e);
      }
    }

    // 2. Fire-and-forget genome consolidation.
    if (process.env.ASHLR_GENOME_AUTO !== "0") {
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.CODEX_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), "..");
        const consolidateTs = join(pluginRoot, "scripts", "genome-auto-consolidate.ts");
        if (existsSync(consolidateTs)) {
          Bun.spawn(["bun", "run", consolidateTs, "--dir", process.cwd()], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          });
        }
      } catch { /* best-effort */ }
    }

    // SubagentStop is a decision-control event: it supports no additionalContext.
    // Side effects are done; exit silently (exit 0, no stdout).
  } catch (e) {
    noteHookError("subagent-stop-rollup", "main", e);
  }
}

if (import.meta.main) {
  void main();
}
