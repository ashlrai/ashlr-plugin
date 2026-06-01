#!/usr/bin/env bun
/**
 * subagent-stop-rollup.ts — SubagentStop hook.
 *
 * When a subagent (Task) finishes:
 *   1. Reads the subagent's stdin payload for task_id / subagent_session_id.
 *   2. Appends a rollup line to ~/.ashlr/session-log.jsonl (unless ASHLR_SESSION_LOG=0).
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

import { appendFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

import { noteHookError } from "./_hook-errors";

interface SubagentStopPayload {
  task_id?: string;
  subagent_session_id?: string;
  [key: string]: unknown;
}

export interface RollupLine {
  ts: string;
  event: "subagent_stop";
  task_id: string | null;
  subagent_session_id: string | null;
  tokens_saved: number;
  calls: number;
  top_tool: string | null;
}

export interface SubagentSummary {
  tokensSaved: number;
  calls: number;
  topTool: string | null;
}

/** Build the JSONL rollup line for a finished subagent. */
export function buildRollupLine(opts: {
  taskId: string | null;
  subagentSessionId: string | null;
  summary: SubagentSummary;
  ts?: string;
}): RollupLine {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    event: "subagent_stop",
    task_id: opts.taskId,
    subagent_session_id: opts.subagentSessionId,
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
    const taskId = payload.task_id ?? null;
    const subagentSessionId = payload.subagent_session_id ?? null;

    // Read subagent session stats.
    let summary: SubagentSummary = { tokensSaved: 0, calls: 0, topTool: null };
    try {
      const statsPath = join(
        process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), ".."),
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

    // 1. Append rollup line to session-log.jsonl.
    if (process.env.ASHLR_SESSION_LOG !== "0") {
      try {
        const logPath = join(process.env.HOME ?? homedir(), ".ashlr", "session-log.jsonl");
        const line = buildRollupLine({ taskId, subagentSessionId, summary });
        await appendFile(logPath, JSON.stringify(line) + "\n");
      } catch (e) {
        noteHookError("subagent-stop-rollup", "append-log", e);
      }
    }

    // 2. Fire-and-forget genome consolidation.
    if (process.env.ASHLR_GENOME_AUTO !== "0") {
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), "..");
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
