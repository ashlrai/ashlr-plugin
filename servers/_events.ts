/**
 * Observability event emitter for ashlr MCP tools.
 *
 * Appends JSONL records to ~/.ashlr/session-log.jsonl (the same file the
 * PostToolUse hook writes to). Purely additive — does NOT change any tool's
 * return shape and never throws.
 *
 * Kill switch: set ASHLR_SESSION_LOG=0 to disable all emission.
 */

import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { currentSessionId } from "./_stats";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventKind =
  | "tool_fallback"
  | "tool_escalate"
  | "tool_error"
  | "tool_noop"
  | "tool_call"
  | "accounting_cache_hit"
  | "tool_crashed"
  // v1.22 Track A — savings-math trust pass
  | "tool_low_confidence_shipped"
  | "tool_skip_micro_edit"
  // v1.22 Track D — LLM provider telemetry
  | "llm_summarize_provider_used"
  // v1.22 Track G — adoption + visibility telemetry
  | "tool_called_after_block"
  | "genome_route_taken"
  | "embed_cache_hit"
  | "embed_cache_miss"
  // v1.23 Track HH — genome stale detection
  | "genome_stale_detected";

export interface EventPayload {
  tool: string;
  reason?: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Path helpers (resolve at call-time so tests overriding $HOME work)
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

function logPath(): string {
  return join(home(), ".ashlr", "session-log.jsonl");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single observability event to the session log.
 *
 * Schema mirrors the PostToolUse hook:
 *   ts, agent, event, tool, cwd, session, + any extras from payload.extra
 *
 * Best-effort: never throws.
 */
export async function logEvent(
  event: EventKind,
  payload: EventPayload,
): Promise<void> {
  if (process.env.ASHLR_SESSION_LOG === "0") return;

  try {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      agent: "ashlr-mcp",
      event,
      tool: payload.tool,
      cwd: process.cwd(),
      session: currentSessionId(),
    };

    if (payload.reason !== undefined) {
      record.reason = payload.reason;
    }

    if (payload.extra) {
      for (const [k, v] of Object.entries(payload.extra)) {
        record[k] = v;
      }
    }

    const line = JSON.stringify(record) + "\n";
    const path = logPath();

    // Ensure the directory exists (best-effort; may already exist).
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    await appendFile(path, line, "utf-8");
  } catch {
    // Never propagate — this is observability, not a critical path.
  }
}
