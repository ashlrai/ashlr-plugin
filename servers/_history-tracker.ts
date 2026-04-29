/**
 * _history-tracker.ts — Per-session tool result history for multi-turn staleness tracking.
 *
 * Records every ashlr tool result emitted this session with size + freshness metadata.
 * Stored in ~/.ashlr/session-history/<sessionId>.jsonl (one JSONL line per result).
 *
 * Freshness decay (by subsequent tool-call count since emission):
 *   turns 0–4  → 1.0 (fresh)
 *   turns 5–14 → 0.5 (stale)
 *   turns 15+  → 0.2 (very stale)
 *
 * v1.25 starting coefficients — telemetry from multi_turn_stale_estimate events will
 * tune these in v1.26.
 *
 * Design:
 *   - Best-effort only — never throws, never blocks a tool call.
 *   - Append-only JSONL for crash-safety and cross-process reads.
 *   - Session-scoped: each sessionId gets its own file, GC'd by session-end hook.
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables all writes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Freshness is 1.0 for the first N turns after emission. */
export const FRESH_TURNS = 5;

/** Turns 5–14 after emission decay to this freshness. */
export const STALE_FRESHNESS = 0.5;

/** Turns 15+ after emission decay to this freshness. */
export const VERY_STALE_FRESHNESS = 0.2;

/** Results older than this many turns are considered "stale" for compaction purposes. */
export const STALE_TURN_THRESHOLD = 5;

/** Nudge threshold: total stale bytes before the adaptive nudge fires. */
export const STALE_BYTES_NUDGE_THRESHOLD = 50 * 1024; // 50 KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single history entry appended per tool call. */
export interface HistoryEntry {
  /** Unix ms when the result was emitted. */
  ts: number;
  /** Tool name (e.g. "ashlr__read", "Read"). */
  tool: string;
  /** Byte size of the tool result content. */
  sizeBytes: number;
  /** First 8 chars of SHA-256 of the result content (for dedup detection). */
  contentSha8: string;
  /**
   * Global turn counter at time of emission. Starts at 0 and increments with
   * every PostToolUse event recorded in this session (across all tools).
   */
  turn: number;
  /** Session ID — redundant with the filename but useful for sanity checks. */
  sessionId: string;
}

/** Freshness-annotated history entry (computed, not stored). */
export interface AnnotatedEntry extends HistoryEntry {
  /** Turns elapsed since emission (currentTurn - entry.turn). */
  turnDelta: number;
  /** Freshness score [0.2, 1.0]. */
  freshness: number;
  /** True when turnDelta >= STALE_TURN_THRESHOLD. */
  isStale: boolean;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.ASHLR_HOME_OVERRIDE?.trim() || process.env.HOME || homedir();
}

export function historyDir(homeDir: string = home()): string {
  return join(homeDir, ".ashlr", "session-history");
}

export function historyPath(sessionId: string, homeDir: string = home()): string {
  return join(historyDir(homeDir), `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Session ID resolution
// ---------------------------------------------------------------------------

/**
 * Derive a session ID using the same strategy as session-start.ts:
 *   CLAUDE_SESSION_ID → ASHLR_SESSION_ID → hash of ppid + cwd.
 * Stable within a single Claude Code session because ppid + cwd are constant.
 */
export function resolveSessionId(): string {
  const explicit =
    process.env.CLAUDE_SESSION_ID?.trim() ||
    process.env.ASHLR_SESSION_ID?.trim();
  if (explicit) return explicit;
  const seed = `${process.ppid ?? process.pid}:${process.cwd()}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

// ---------------------------------------------------------------------------
// SHA-8 helper
// ---------------------------------------------------------------------------

/** Compute first 8 hex chars of a simple djb2 hash (no native crypto needed). */
export function sha8(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Current turn counter
// ---------------------------------------------------------------------------

/**
 * Read the current session turn count from the history file.
 * Turn = number of entries already written (0-indexed).
 */
export function readCurrentTurn(sessionId: string, homeDir: string = home()): number {
  try {
    const p = historyPath(sessionId, homeDir);
    if (!existsSync(p)) return 0;
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Record a result
// ---------------------------------------------------------------------------

/**
 * Append one history entry for a completed tool call.
 * Best-effort — never throws.
 *
 * @param tool       Tool name from PostToolUse payload.
 * @param content    String representation of the result (for size + sha8).
 * @param sessionId  Override for testing.
 * @param homeDir    Override for testing.
 * @param now        Override for testing.
 */
export function recordResult(
  tool: string,
  content: string,
  sessionId: string = resolveSessionId(),
  homeDir: string = home(),
  now: number = Date.now(),
): void {
  if (process.env.ASHLR_SESSION_LOG === "0") return;

  try {
    const dir = historyDir(homeDir);
    mkdirSync(dir, { recursive: true });

    const turn = readCurrentTurn(sessionId, homeDir);
    const entry: HistoryEntry = {
      ts: now,
      tool,
      sizeBytes: Buffer.byteLength(content, "utf-8"),
      contentSha8: sha8(content),
      turn,
      sessionId,
    };

    appendFileSync(historyPath(sessionId, homeDir), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Best-effort — never block the tool call.
  }
}

// ---------------------------------------------------------------------------
// Read and annotate history
// ---------------------------------------------------------------------------

/**
 * Read all history entries for a session.
 * Returns [] on any error.
 */
export function readHistory(
  sessionId: string = resolveSessionId(),
  homeDir: string = home(),
): HistoryEntry[] {
  try {
    const p = historyPath(sessionId, homeDir);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try { return JSON.parse(l) as HistoryEntry; } catch { return null; }
      })
      .filter((e): e is HistoryEntry => e !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Freshness computation
// ---------------------------------------------------------------------------

/**
 * Compute freshness score given the number of turns since emission.
 *
 *   0–4 turns  → 1.0
 *   5–14 turns → 0.5
 *   15+ turns  → 0.2
 */
export function freshnessScore(turnDelta: number): number {
  if (turnDelta < FRESH_TURNS) return 1.0;
  if (turnDelta < 15) return STALE_FRESHNESS;
  return VERY_STALE_FRESHNESS;
}

/**
 * Annotate all history entries with freshness metadata relative to currentTurn.
 */
export function annotateHistory(
  entries: HistoryEntry[],
  currentTurn: number,
): AnnotatedEntry[] {
  return entries.map((e) => {
    const turnDelta = Math.max(0, currentTurn - e.turn);
    const freshness = freshnessScore(turnDelta);
    return {
      ...e,
      turnDelta,
      freshness,
      isStale: turnDelta >= STALE_TURN_THRESHOLD,
    };
  });
}

// ---------------------------------------------------------------------------
// Stale byte total
// ---------------------------------------------------------------------------

/**
 * Compute total byte size of stale results in the current session.
 * Used by the adaptive nudge and /ashlr-compact.
 */
export function staleByteTotal(
  sessionId: string = resolveSessionId(),
  homeDir: string = home(),
): { staleBytes: number; staleResults: number; sessionTurnCount: number } {
  try {
    const entries = readHistory(sessionId, homeDir);
    const currentTurn = entries.length;
    const annotated = annotateHistory(entries, currentTurn);
    const stale = annotated.filter((e) => e.isStale);
    return {
      staleBytes: stale.reduce((acc, e) => acc + e.sizeBytes, 0),
      staleResults: stale.length,
      sessionTurnCount: currentTurn,
    };
  } catch {
    return { staleBytes: 0, staleResults: 0, sessionTurnCount: 0 };
  }
}
