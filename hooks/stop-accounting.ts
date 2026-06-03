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
 * Stop is a decision-control event: it does NOT support hookSpecificOutput /
 * additionalContext. This hook does its side effect (the idempotent session-log
 * write) and exits silently. Per-session savings are surfaced via the status
 * line and /ashlr-savings — Stop fires every turn, so a summary here is noise.
 *
 * Env toggles:
 *   ASHLR_SESSION_LOG=0 — skip log append entirely
 *
 * Contract: never throws, always exits 0.
 */

import { appendFile, readFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

import { noteHookError } from "./_hook-errors";
import { currentSessionId } from "../servers/_stats";

interface LogEntry {
  ts?: string;
  event?: string;
  session?: string;
  [key: string]: unknown;
}

interface StopPayload {
  session_id?: string;
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

async function main(): Promise<void> {
  try {
    let payload: StopPayload = {};
    // Drain stdin defensively. Codex includes session_id in this payload.
    try {
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        await Promise.race([
          (async () => {
            for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
              chunks.push(chunk);
            }
          })(),
          new Promise((r) => setTimeout(r, 50)),
        ]);
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        if (raw) payload = JSON.parse(raw) as StopPayload;
      }
    } catch { /* ignore */ }

    const sessionId = typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : currentSessionId();
    const logPath = join(process.env.HOME ?? homedir(), ".ashlr", "session-log.jsonl");

    // Read session stats.
    let tokensSaved = 0;
    let calls = 0;
    let topTool: string | null = null;
    let topCalls = 0;
    try {
      const statsPath = join(
        process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), ".."),
        "servers",
        "_stats",
      );
      const { readCurrentSession } = await import(statsPath) as {
        readCurrentSession: (id?: string) => Promise<{ tokensSaved: number; calls: number; byTool: Record<string, { calls: number }> }>;
      };
      const sess = await readCurrentSession(sessionId);
      tokensSaved = sess.tokensSaved;
      calls = sess.calls;
      for (const [tool, pt] of Object.entries(sess.byTool ?? {})) {
        if (pt.calls > topCalls) { topCalls = pt.calls; topTool = tool; }
      }
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

    // Stop is a decision-control event: it supports no additionalContext.
    // Side effects are done; exit silently (exit 0, no stdout).
  } catch (e) {
    noteHookError("stop-accounting", "main", e);
  }
}

if (import.meta.main) {
  void main();
}
