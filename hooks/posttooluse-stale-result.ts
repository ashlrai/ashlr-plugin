#!/usr/bin/env bun
/**
 * posttooluse-stale-result.ts — Track ashlr tool results for multi-turn staleness.
 *
 * PostToolUse hook. Records every ashlr__read / ashlr__grep / Read / Grep result
 * into the per-session history JSONL so the freshness tracker can later identify
 * stale accumulation.
 *
 * Also fires the once-per-session adaptive nudge when stale bytes exceed 50 KB.
 *
 * Design:
 *   - Best-effort only — never throws, always exits 0.
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables everything.
 *   - Only tracks read-class tools (Read, Grep, ashlr__read, ashlr__grep).
 *     Edit/Write results don't accumulate stale read content.
 *
 * Hook contract (PostToolUse):
 *   stdin  → { tool_name, tool_input?, tool_result? }
 *   stdout → { hookSpecificOutput: { hookEventName: "PostToolUse",
 *                                    additionalContext?: string } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import {
  recordResult,
  readHistory,
  resolveSessionId,
  staleByteTotal,
  STALE_BYTES_NUDGE_THRESHOLD,
} from "../servers/_history-tracker";
import { logMultiTurnStaleEvent, logPreCompactionNudgeEvent } from "../servers/_telemetry";

// ---------------------------------------------------------------------------
// Tools to track
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pre-compaction nudge constants
// ---------------------------------------------------------------------------

/** Token estimate heuristic: 4 bytes per token. */
const BYTES_PER_TOKEN = 4;

/** Fire the pre-compaction nudge when estimated tokens exceed this. */
const PRECOMPACT_TOKEN_THRESHOLD = 65_000;

/** Assumed auto-compact ceiling (used for percentage display). */
const AUTOCOMPACT_TOKEN_CEILING = 80_000;

// ---------------------------------------------------------------------------
// Pre-compaction nudge state (once-per-session file flag)
// ---------------------------------------------------------------------------

function precompactNudgePath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".ashlr", "precompact-fired", sessionId);
}

function hasPrecompactNudgeFired(sessionId: string, homeDir: string): boolean {
  try {
    return existsSync(precompactNudgePath(homeDir, sessionId));
  } catch {
    return false;
  }
}

function markPrecompactNudgeFired(sessionId: string, homeDir: string): void {
  try {
    const p = precompactNudgePath(homeDir, sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(Date.now()), "utf-8");
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Stale nudge state
// ---------------------------------------------------------------------------

function staleNudgePath(homeDir: string): string {
  return join(homeDir, ".ashlr", "stale-nudge-state.json");
}

interface StaleNudgeState {
  sessionId: string;
  firedAt: number;
}

function hasNudgeFiredThisSession(sessionId: string, homeDir: string): boolean {
  try {
    const p = staleNudgePath(homeDir);
    if (!existsSync(p)) return false;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<StaleNudgeState>;
    return raw.sessionId === sessionId;
  } catch {
    return false;
  }
}

function markNudgeFired(sessionId: string, homeDir: string, now: number): void {
  try {
    const p = staleNudgePath(homeDir);
    mkdirSync(dirname(p), { recursive: true });
    const state: StaleNudgeState = { sessionId, firedAt: now };
    writeFileSync(p, JSON.stringify(state), "utf-8");
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Result content extraction
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
// Main decision function (exported for tests)
// ---------------------------------------------------------------------------

export interface ProcessOpts {
  home?: string;
  sessionId?: string;
  now?: number;
}

export function decide(
  payload: Record<string, unknown>,
  opts: ProcessOpts = {},
): HookOutput {
  if (process.env.ASHLR_SESSION_LOG === "0") return passThrough();

  const toolName = payload?.tool_name;
  if (typeof toolName !== "string" || !TRACKED_TOOLS.has(toolName)) {
    return passThrough();
  }

  const homeDir =
    opts.home ??
    (process.env.ASHLR_HOME_OVERRIDE?.trim() || process.env.HOME || homedir());
  const sessionId = opts.sessionId ?? resolveSessionId();
  const now = opts.now ?? Date.now();

  // Record this result in the history JSONL.
  const content = extractContent(payload);
  recordResult(toolName, content, sessionId, homeDir, now);

  // -------------------------------------------------------------------------
  // 2B — Pre-compaction nudge: warn once when cumulative bytes approach
  //       the auto-compact ceiling (~80K tokens).
  // -------------------------------------------------------------------------
  if (!hasPrecompactNudgeFired(sessionId, homeDir)) {
    try {
      const allEntries = readHistory(sessionId, homeDir);
      const cumulativeBytes = allEntries.reduce((acc, e) => acc + e.sizeBytes, 0);
      const estimatedTokens = Math.floor(cumulativeBytes / BYTES_PER_TOKEN);
      if (estimatedTokens > PRECOMPACT_TOKEN_THRESHOLD) {
        const pct = Math.min(100, Math.round((estimatedTokens / AUTOCOMPACT_TOKEN_CEILING) * 100));
        markPrecompactNudgeFired(sessionId, homeDir);
        try {
          logPreCompactionNudgeEvent({ cumulativeBytes, estimatedTokens, pct });
        } catch {
          // Telemetry never blocks.
        }
        const precompactNudge =
          `[ashlr] context approaching auto-compact (~${pct}% of 80K). ` +
          `Run /ashlr-compact now to dedupe stale results before lag hits.`;
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: precompactNudge,
          },
        };
      }
    } catch {
      // Best-effort — never block tool call.
    }
  }

  // -------------------------------------------------------------------------
  // Stale-result nudge (original behaviour)
  // -------------------------------------------------------------------------

  // Check if stale bytes exceed nudge threshold.
  if (hasNudgeFiredThisSession(sessionId, homeDir)) return passThrough();

  const { staleBytes, staleResults, sessionTurnCount } = staleByteTotal(sessionId, homeDir);

  // Emit telemetry regardless of nudge threshold (best-effort).
  try {
    logMultiTurnStaleEvent({ sessionTurnCount, staleBytes, staleResults });
  } catch {
    // Telemetry never blocks.
  }

  if (staleBytes < STALE_BYTES_NUDGE_THRESHOLD) return passThrough();

  // Fire the once-per-session adaptive nudge.
  markNudgeFired(sessionId, homeDir, now);

  const staleKb = Math.round(staleBytes / 1024);
  const nudge =
    `[ashlr] ~${staleKb} KB of stale tool output is accumulating in this session ` +
    `(${staleResults} result${staleResults === 1 ? "" : "s"} from 5+ turns ago). ` +
    `Run \`/ashlr-compact\` to surface a recompression plan.`;

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: nudge,
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
