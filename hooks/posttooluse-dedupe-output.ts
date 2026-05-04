#!/usr/bin/env bun
/**
 * posttooluse-dedupe-output.ts — Elide duplicate tool results across turns.
 *
 * PostToolUse hook for Read / Grep / ashlr__read / ashlr__grep.
 *
 * When the same content (identified by contentSha8) was already seen from the
 * same tool class (Read↔ashlr__read, Grep↔ashlr__grep) within the last 8
 * turns of the current session, the result is elided in additionalContext so
 * the model doesn't re-ingest redundant bytes.
 *
 * Design:
 *   - Best-effort — never throws, always exits 0.
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables everything.
 *   - Uses the same session-history JSONL written by posttooluse-stale-result.
 *
 * Hook contract (PostToolUse):
 *   stdin  → { tool_name, tool_input?, tool_result? }
 *   stdout → { hookSpecificOutput: { hookEventName: "PostToolUse",
 *                                    additionalContext?: string } }
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import {
  readHistory,
  resolveSessionId,
  sha8,
  historyDir,
  historyPath,
  readCurrentTurn,
  type HistoryEntry,
} from "../servers/_history-tracker";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many recent turns to scan for duplicates. */
const DEDUP_LOOKBACK_TURNS = 8;

// ---------------------------------------------------------------------------
// Tool class normalisation — Read↔ashlr__read, Grep↔ashlr__grep
// ---------------------------------------------------------------------------

type ToolClass = "read" | "grep" | "other";

const TRACKED_TOOLS = new Set([
  "Read",
  "Grep",
  "mcp__ashlr-efficiency__ashlr__read",
  "mcp__ashlr-efficiency__ashlr__grep",
  "mcp__plugin_ashlr_ashlr__ashlr__read",
  "mcp__plugin_ashlr_ashlr__ashlr__grep",
  "ashlr__read",
  "ashlr__grep",
]);

function toolClass(toolName: string): ToolClass {
  const t = toolName.toLowerCase();
  if (t === "read" || t.endsWith("ashlr__read")) return "read";
  if (t === "grep" || t.endsWith("ashlr__grep")) return "grep";
  return "other";
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractContent(payload: Record<string, unknown>): string {
  const result = payload.tool_result ?? payload.tool_response ?? payload.tool_output;
  if (result == null) return "";
  if (typeof result === "string") return result;
  try { return JSON.stringify(result); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Hook output type
// ---------------------------------------------------------------------------

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
}

function passThrough(): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
}

// ---------------------------------------------------------------------------
// Dedup stats path (for bytesSaved accumulation)
// ---------------------------------------------------------------------------

export function dedupStatsPath(homeDir: string): string {
  return join(homeDir, ".ashlr", "dedupe-stats.json");
}

export interface DedupeStats {
  bytesSaved: number;
  dedupeCount: number;
}

function loadDedupeStats(homeDir: string): DedupeStats {
  try {
    const p = dedupStatsPath(homeDir);
    if (!existsSync(p)) return { bytesSaved: 0, dedupeCount: 0 };
    return JSON.parse(readFileSync(p, "utf-8")) as DedupeStats;
  } catch {
    return { bytesSaved: 0, dedupeCount: 0 };
  }
}

function saveDedupeStats(stats: DedupeStats, homeDir: string): void {
  try {
    const p = dedupStatsPath(homeDir);
    mkdirSync(dirname(p), { recursive: true });
    const { writeFileSync } = require("fs") as typeof import("fs");
    writeFileSync(p, JSON.stringify(stats), "utf-8");
  } catch {
    // Best-effort.
  }
}

function accumulateBytesSaved(bytes: number, homeDir: string): void {
  try {
    const stats = loadDedupeStats(homeDir);
    stats.bytesSaved += bytes;
    stats.dedupeCount += 1;
    saveDedupeStats(stats, homeDir);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Main decision function (exported for tests)
// ---------------------------------------------------------------------------

export interface DecideOpts {
  home?: string;
  sessionId?: string;
  now?: number;
}

export function decide(
  payload: Record<string, unknown>,
  opts: DecideOpts = {},
): HookOutput {
  if (process.env.ASHLR_SESSION_LOG === "0") return passThrough();

  const toolName = payload?.tool_name;
  if (typeof toolName !== "string" || !TRACKED_TOOLS.has(toolName)) {
    return passThrough();
  }

  const klass = toolClass(toolName);
  if (klass === "other") return passThrough();

  const homeDir =
    opts.home ??
    (process.env.ASHLR_HOME_OVERRIDE?.trim() || process.env.HOME || homedir());
  const sessionId = opts.sessionId ?? resolveSessionId();

  const content = extractContent(payload);
  if (!content) return passThrough();

  const contentHash = sha8(content);
  const contentBytes = Buffer.byteLength(content, "utf-8");

  // Read last DEDUP_LOOKBACK_TURNS entries from session history.
  const history = readHistory(sessionId, homeDir);
  if (history.length === 0) return passThrough();

  const currentTurn = history.length;
  const lookbackStart = Math.max(0, currentTurn - DEDUP_LOOKBACK_TURNS);
  const recentEntries = history.slice(lookbackStart);

  // Find a prior turn with matching tool class AND same contentSha8.
  const match = recentEntries.find(
    (e: HistoryEntry) =>
      toolClass(e.tool) === klass &&
      e.contentSha8 === contentHash &&
      e.turn < currentTurn,
  );

  if (!match) return passThrough();

  // Duplicate found — elide and report.
  accumulateBytesSaved(contentBytes, homeDir);

  const elision =
    `[ashlr-dedupe] identical to turn ${match.turn} result ` +
    `(sha8=${contentHash}); content elided to save ${contentBytes}B`;

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: elision,
    },
  };
}

// ---------------------------------------------------------------------------
// Stdin reading
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let payload: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
    return;
  }
  try {
    process.stdout.write(JSON.stringify(decide(payload)));
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
  }
}

if (import.meta.main) {
  await main();
}
