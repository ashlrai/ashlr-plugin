#!/usr/bin/env bun
/**
 * sessionend-savings-nudge.ts — Proactive savings nudge at session end.
 *
 * Fires at SessionEnd (wired via session-end-consolidate.ts) when:
 *   - Session-time milestones: current session active > 2h or > 7h.
 *   - Lifetime savings thresholds: $5, $25, $100.
 *
 * Dedupe:
 *   - Session-time nudges: tracked via `last_session_nudge_ts` in the
 *     nudge state file (once per threshold crossing per session start).
 *   - Lifetime thresholds: tracked via `lifetime_nudge_ticks` array in
 *     ~/.ashlr/savings-nudge-state.json — appended once, never re-fires.
 *
 * Output: prints nudge text to stdout (Claude Code SessionEnd hook channel).
 * Does NOT fire when total lifetime savings = 0 (no activity yet).
 *
 * Telemetry: emits a `tool_call` event with tool_name: "savings_nudge_fired"
 * and payload describing the threshold/milestone. Gated on telemetry opt-in.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { costFor } from "../servers/_pricing.ts";
import { recordTelemetryEvent } from "../servers/_telemetry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NudgeState {
  /** ISO timestamps of session-start times where we already nudged. */
  last_session_nudge_ts: string | null;
  /** Lifetime $ thresholds already fired (never re-fire). */
  lifetime_nudge_ticks: number[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Session-time milestones in ms. Order matters: check 7h before 2h so we
 *  fire the stronger message when applicable. */
const SESSION_MILESTONES_MS: { ms: number; label: string }[] = [
  { ms: 7 * 60 * 60_000, label: "7h" },
  { ms: 2 * 60 * 60_000, label: "2h" },
];

/** Lifetime $ thresholds (ascending). Fire once per threshold crossing. */
const LIFETIME_THRESHOLDS_USD: number[] = [5, 25, 100];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function nudgeStatePath(homeDir: string = homedir()): string {
  return join(homeDir, ".ashlr", "savings-nudge-state.json");
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export function readNudgeState(homeDir: string = homedir()): NudgeState {
  try {
    const p = nudgeStatePath(homeDir);
    if (!existsSync(p)) return defaultState();
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<NudgeState>;
    return {
      last_session_nudge_ts:
        typeof raw.last_session_nudge_ts === "string" ? raw.last_session_nudge_ts : null,
      lifetime_nudge_ticks: Array.isArray(raw.lifetime_nudge_ticks)
        ? (raw.lifetime_nudge_ticks as unknown[]).filter(
            (v): v is number => typeof v === "number",
          )
        : [],
    };
  } catch {
    return defaultState();
  }
}

function defaultState(): NudgeState {
  return { last_session_nudge_ts: null, lifetime_nudge_ticks: [] };
}

export function writeNudgeState(state: NudgeState, homeDir: string = homedir()): void {
  try {
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    const finalPath = nudgeStatePath(homeDir);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, finalPath);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Stats reader (minimal — only what we need)
// ---------------------------------------------------------------------------

interface StatsFile {
  schemaVersion?: number;
  sessions?: Record<string, { startedAt?: string; tokensSaved?: number }>;
  lifetime?: { tokensSaved?: number };
}

export function readStats(homeDir: string = homedir()): StatsFile | null {
  try {
    const p = join(homeDir, ".ashlr", "stats.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as StatsFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nudge text builders
// ---------------------------------------------------------------------------

function buildNudge(lead: string): string {
  return `${lead}\nRun /ashlr-savings for a breakdown, or /ashlr-tier to see what Pro adds for $12/mo.`;
}

export function buildSessionMilestoneNudge(label: string): string {
  return buildNudge(
    `You've been coding for ${label} straight — ashlr has been saving tokens the whole time.`,
  );
}

export function buildLifetimeThresholdNudge(_threshold: number, dollars: number): string {
  const formatted =
    dollars < 100 ? `$${dollars.toFixed(2)}` : `$${Math.round(dollars)}`;
  return buildNudge(`You've saved ${formatted} in API tokens with ashlr. Keep it up!`);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export interface NudgeCheckResult {
  /** Nudge text to emit, or null if nothing should fire. */
  nudgeText: string | null;
  /** Type of nudge for telemetry. */
  kind: "session_milestone" | "lifetime_threshold" | null;
  /** The threshold/milestone label for telemetry display ("$5", "2h"). */
  thresholdLabel: string | null;
  /** The numeric lifetime threshold (USD) — null for session milestones. */
  thresholdValue: number | null;
}

/**
 * Pure function — determines if/what nudge to fire given the current state.
 * Does not perform any IO. Called by checkAndFireNudge which handles IO.
 *
 * @param stats - stats file contents
 * @param state - current nudge state
 * @param sessionStartedAt - ISO string of current session start (from stats)
 * @param nowMs - current timestamp in ms
 */
export function computeNudge(
  lifetimeTokensSaved: number,
  sessionDurationMs: number,
  state: NudgeState,
  sessionStartedAt: string,
  nowMs: number,
): NudgeCheckResult {
  const none: NudgeCheckResult = {
    nudgeText: null,
    kind: null,
    thresholdLabel: null,
    thresholdValue: null,
  };

  // No savings yet → never nudge.
  if (lifetimeTokensSaved <= 0) return none;

  const lifetimeDollars = costFor(lifetimeTokensSaved);

  // -----------------------------------------------------------------------
  // 1. Lifetime threshold nudges (highest priority — fire once, ever).
  // -----------------------------------------------------------------------
  for (const threshold of LIFETIME_THRESHOLDS_USD) {
    if (lifetimeDollars >= threshold && !state.lifetime_nudge_ticks.includes(threshold)) {
      return {
        nudgeText: buildLifetimeThresholdNudge(threshold, lifetimeDollars),
        kind: "lifetime_threshold",
        thresholdLabel: `$${threshold}`,
        thresholdValue: threshold,
      };
    }
  }

  // -----------------------------------------------------------------------
  // 2. Session-time milestone nudges (once per session per milestone).
  // -----------------------------------------------------------------------
  // Dedupe: we use `last_session_nudge_ts` to track when we nudged in the
  // context of THIS session start. If the sessionStartedAt matches, we've
  // already nudged this session.
  const alreadyNudgedThisSession = state.last_session_nudge_ts === sessionStartedAt;
  if (!alreadyNudgedThisSession) {
    for (const { ms, label } of SESSION_MILESTONES_MS) {
      if (sessionDurationMs >= ms) {
        return {
          nudgeText: buildSessionMilestoneNudge(label),
          kind: "session_milestone",
          thresholdLabel: label,
          thresholdValue: null,
        };
      }
    }
  }

  return none;
}

/**
 * Main entry: read stats + state, compute nudge, emit if needed, update state.
 * Returns the nudge text that was emitted (or null).
 */
export function checkAndFireNudge(
  homeDir: string = homedir(),
  nowMs: number = Date.now(),
): string | null {
  try {
    const stats = readStats(homeDir);
    if (!stats) return null;

    const lifetimeTokensSaved = stats.lifetime?.tokensSaved ?? 0;
    if (lifetimeTokensSaved <= 0) return null;

    // Find the current session's startedAt. Use the session with the most
    // recent activity (highest tokens or lexicographically latest startedAt).
    let sessionStartedAt = "";
    let sessionTokensSaved = 0;
    const sessions = stats.sessions ?? {};
    for (const bucket of Object.values(sessions)) {
      const tok = bucket.tokensSaved ?? 0;
      if (tok > sessionTokensSaved) {
        sessionTokensSaved = tok;
        sessionStartedAt = bucket.startedAt ?? "";
      }
    }

    // If we can't determine session start, skip session milestone nudges.
    // We use epoch as the fallback so duration math still works (will be 0).
    const sessionStart = sessionStartedAt ? Date.parse(sessionStartedAt) : nowMs;
    const sessionDurationMs = Number.isFinite(sessionStart)
      ? Math.max(0, nowMs - sessionStart)
      : 0;

    const state = readNudgeState(homeDir);
    const result = computeNudge(
      lifetimeTokensSaved,
      sessionDurationMs,
      state,
      sessionStartedAt,
      nowMs,
    );

    if (!result.nudgeText) return null;

    // Update state — prevent re-fire. Write BEFORE printing to narrow the race
    // window between concurrent SessionEnd hooks (e.g. two Claude Code windows
    // closing simultaneously). The atomic write in writeNudgeState (tmp+rename)
    // protects against partial-write corruption.
    const updated: NudgeState = { ...state };
    if (result.kind === "lifetime_threshold" && result.thresholdValue !== null) {
      if (!updated.lifetime_nudge_ticks.includes(result.thresholdValue)) {
        updated.lifetime_nudge_ticks = [
          ...updated.lifetime_nudge_ticks,
          result.thresholdValue,
        ];
      }
    } else if (result.kind === "session_milestone") {
      updated.last_session_nudge_ts = sessionStartedAt;
    }
    writeNudgeState(updated, homeDir);

    // Emit telemetry (best-effort, gated by opt-in).
    try {
      recordTelemetryEvent(
        {
          kind: "tool_call",
          tool: "savings_nudge_fired",
          tool_name: "savings_nudge_fired",
          rawBytes: 0,
          compactBytes: 0,
          fellBack: false,
          providerUsed: result.kind ?? "unknown",
          durationMs: 0,
        },
        homeDir,
      );
    } catch {
      /* telemetry never breaks nudge */
    }

    return result.nudgeText;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI entry (invoked by session-end-consolidate.ts as a sub-spawn)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const text = checkAndFireNudge();
  if (text) {
    process.stdout.write("\n" + text + "\n");
  }
  process.exit(0);
}
