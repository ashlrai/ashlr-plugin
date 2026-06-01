#!/usr/bin/env bun
/**
 * stop-accounting.ts — Stop hook.
 *
 * Deterministic session finalization that complements SessionEnd.
 *
 * Idempotency guard: before appending to ~/.ashlr/session-log.jsonl, reads
 * the last ~3 lines and skips if a session_end/stop entry for this session
 * already exists within the last 60 seconds.
 *
 * Emits a one-line final savings summary as additionalContext ONLY when
 * tokensSaved > 0.
 *
 * Env toggles:
 *   ASHLR_SESSION_LOG=0 — skip log append entirely (still emits context)
 *
 * Contract: never throws, always exits 0.
 */

import { appendFile, readFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

import { noteHookError } from "./_hook-errors";
import { currentSessionId } from "../servers/_stats";

interface StopHookOutput {
  hookSpecificOutput: {
    hookEventName: "Stop";
    additionalContext?: string;
  };
}

interface LogEntry {
  ts?: string;
  event?: string;
  session?: string;
  [key: string]: unknown;
}

const IDEMPOTENCY_WINDOW_MS = 60_000;

/** Read the last N lines from a file. Returns [] if the file doesn't exist. */
async function readLastLines(path: string, n: number): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Check if a session_end or stop entry for `sessionId` already exists
 * within the last 60 seconds in the last 3 lines.
 */
export function isAlreadyRecorded(lines: string[], sessionId: string): boolean {
  const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (
        entry.session === sessionId &&
        (entry.event === "session_end" || entry.event === "stop") &&
        entry.ts &&
        new Date(entry.ts).getTime() >= cutoff
      ) {
        return true;
      }
    } catch { /* skip malformed lines */ }
  }
  return false;
}

export interface FinalSummaryOpts {
  tokensSaved: number;
  calls: number;
  topTool: string | null;
  topCalls?: number;
  costUsd: number;
}

/** Build the final savings summary line. Returns "" when tokensSaved is 0. */
export function buildFinalSummary(opts: FinalSummaryOpts): string {
  const { tokensSaved, calls, topTool, topCalls, costUsd } = opts;
  if (tokensSaved <= 0) return "";
  const topPart = topTool ? ` Top: ${topTool}${topCalls ? ` (${topCalls})` : ""}.` : "";
  const dollars = costUsd > 0 ? ` (~$${costUsd.toFixed(2)})` : "";
  return `[ashlr] Session: saved ${tokensSaved.toLocaleString()} tokens${dollars} across ${calls} tool calls.${topPart}`;
}

async function main(): Promise<void> {
  try {
    // Drain stdin defensively.
    try {
      if (!process.stdin.isTTY) {
        await Promise.race([
          (async () => {
            for await (const _ of process.stdin as AsyncIterable<unknown>) { /* discard */ }
          })(),
          new Promise((r) => setTimeout(r, 50)),
        ]);
      }
    } catch { /* ignore */ }

    const sessionId = currentSessionId();
    const logPath = join(process.env.HOME ?? homedir(), ".ashlr", "session-log.jsonl");

    // Read session stats.
    let tokensSaved = 0;
    let calls = 0;
    let topTool: string | null = null;
    let topCalls = 0;
    let costUsd = 0;
    try {
      const statsPath = join(
        process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), ".."),
        "servers",
        "_stats",
      );
      const { readCurrentSession } = await import(statsPath) as {
        readCurrentSession: () => Promise<{ tokensSaved: number; calls: number; byTool: Record<string, { calls: number }> }>;
      };
      const sess = await readCurrentSession();
      tokensSaved = sess.tokensSaved;
      calls = sess.calls;
      for (const [tool, pt] of Object.entries(sess.byTool ?? {})) {
        if (pt.calls > topCalls) { topCalls = pt.calls; topTool = tool; }
      }
      // Compute cost at Sonnet-4.6 input rate ($3/MTok).
      costUsd = (tokensSaved * 3) / 1_000_000;
    } catch { /* best-effort */ }

    // Idempotency + log append.
    if (process.env.ASHLR_SESSION_LOG !== "0") {
      try {
        const lastLines = await readLastLines(logPath, 3);
        if (!isAlreadyRecorded(lastLines, sessionId)) {
          const entry = {
            ts: new Date().toISOString(),
            event: "stop",
            session: sessionId,
            tokens_saved: tokensSaved,
            calls,
            top_tool: topTool,
          };
          await appendFile(logPath, JSON.stringify(entry) + "\n");
        }
      } catch (e) {
        noteHookError("stop-accounting", "append-log", e);
      }
    }

    // Build additionalContext — only when there are savings.
    const summary = buildFinalSummary({ tokensSaved, calls, topTool, costUsd, topCalls });

    const out: StopHookOutput = {
      hookSpecificOutput: {
        hookEventName: "Stop",
        ...(summary ? { additionalContext: summary } : {}),
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    noteHookError("stop-accounting", "main", e);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop" } }));
  }
}

if (import.meta.main) {
  void main();
}
