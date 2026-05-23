#!/usr/bin/env bun
/**
 * sessionend-status-line-nudge.ts — One-shot SessionEnd nudge that surfaces
 * the status-line integration to users who never discovered it.
 *
 * Why: the status line is opt-in. A user who installs the plugin but
 * never edits ~/.claude/settings.json never gets a live savings ticker
 * even though their lifetime tokens are accumulating. This nudge fires
 * exactly once when:
 *
 *   1. The user has ≥ STATUS_LINE_MIN_CALLS successful ashlr tool
 *      calls in their lifetime (stats.json lifetime.calls). Avoids
 *      pestering brand-new installs that don't have savings yet.
 *   2. They installed at least N hours ago AND within the 24h discovery
 *      window — we only surface this in the early-adopter window,
 *      after which the assumption is "they don't want the status line."
 *   3. The Claude Code statusLine is NOT pointing at our script AND
 *      the ashlr.statusLine toggle isn't explicitly off.
 *   4. The per-user category throttle hasn't fired before. One-shot
 *      lifetime — there's no second chance.
 *
 * Best-effort: any I/O error → null. Never throws. Never blocks the
 * SessionEnd safety net (v1.29 2s budget). Bounded by tiny JSON reads
 * only — no jsonl tailing required.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Thresholds + windows
// ---------------------------------------------------------------------------

/** Lifetime call floor before the discovery nudge is allowed. */
export const STATUS_LINE_MIN_CALLS = 3;
/** Hours from firstRunAt within which the nudge may fire. */
export const STATUS_LINE_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// State — one-shot per user (no expiry, never re-fires)
// ---------------------------------------------------------------------------

export interface StatusLineNudgeState {
  /** Epoch ms of the only nudge ever emitted (0 = never). */
  last_status_line_nudge_at: number;
}

const defaultState = (): StatusLineNudgeState => ({
  last_status_line_nudge_at: 0,
});

export function statusLineNudgeStatePath(homeDir: string = homedir()): string {
  return join(homeDir, ".ashlr", "status-line-nudge-state.json");
}

export function readStatusLineNudgeState(
  homeDir: string = homedir(),
): StatusLineNudgeState {
  try {
    const p = statusLineNudgeStatePath(homeDir);
    if (!existsSync(p)) return defaultState();
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<StatusLineNudgeState>;
    return {
      last_status_line_nudge_at:
        typeof raw.last_status_line_nudge_at === "number"
          ? raw.last_status_line_nudge_at
          : 0,
    };
  } catch {
    return defaultState();
  }
}

export function writeStatusLineNudgeState(
  state: StatusLineNudgeState,
  homeDir: string = homedir(),
): void {
  try {
    const dir = join(homeDir, ".ashlr");
    mkdirSync(dir, { recursive: true });
    const finalPath = statusLineNudgeStatePath(homeDir);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, finalPath);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// File readers — small JSON files only; no tail / streaming needed.
// ---------------------------------------------------------------------------

export interface StatsLite {
  lifetimeCalls: number;
  lifetimeTokensSaved: number;
}

export function readStatsLite(homeDir: string = homedir()): StatsLite | null {
  try {
    const p = join(homeDir, ".ashlr", "stats.json");
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      lifetime?: { calls?: number; tokensSaved?: number };
    };
    const calls = raw.lifetime?.calls;
    const toks = raw.lifetime?.tokensSaved;
    return {
      lifetimeCalls: typeof calls === "number" ? calls : 0,
      lifetimeTokensSaved: typeof toks === "number" ? toks : 0,
    };
  } catch {
    return null;
  }
}

export function readFirstRunAtMs(homeDir: string = homedir()): number | null {
  try {
    const p = join(homeDir, ".ashlr", "session-state.json");
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { firstRunAt?: unknown };
    if (typeof raw.firstRunAt !== "string") return null;
    const t = Date.parse(raw.firstRunAt);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the Claude Code statusLine is already wired to our
 * savings-status-line script (i.e. the user has either run
 * install-status-line.ts or hand-configured it). The detection mirrors
 * scripts/install-status-line.ts → isOurStatusLine.
 *
 * Also returns true when settings.ashlr.statusLine is explicitly false —
 * we never nudge someone who has opted out. The literal "ashlr.statusLine"
 * default is true, so a missing value is NOT an opt-out.
 */
export function isStatusLineConfigured(homeDir: string = homedir()): boolean {
  try {
    const p = join(homeDir, ".claude", "settings.json");
    if (!existsSync(p)) return false;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      statusLine?: unknown;
      ashlr?: { statusLine?: unknown };
    };
    // Explicit opt-out wins: never nudge.
    if (raw.ashlr && raw.ashlr.statusLine === false) return true;
    // Check the Claude Code statusLine pointer.
    const sl = raw.statusLine;
    if (!sl || typeof sl !== "object") return false;
    const cmd = (sl as { command?: unknown }).command;
    return typeof cmd === "string" && cmd.includes("savings-status-line");
  } catch {
    // Read/parse failure: assume not configured (so the nudge can fire),
    // but the install-status-line script itself refuses to overwrite a
    // corrupt settings.json, so the worst case is one wasted suggestion.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure: build the nudge text
// ---------------------------------------------------------------------------

/**
 * Format a token count tersely (e.g. "1.2K", "340", "2.1M").
 * Mirrors scripts/savings-status-line.ts → formatTokens so the nudge
 * shows the same scale as the future status line.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

export function buildStatusLineNudge(lifetimeTokens: number): string {
  const tok = formatTokens(lifetimeTokens);
  return [
    `ashlr saved you +${tok} tokens already — see your savings live in your status bar.`,
    `  Run /ashlr-settings install-status-line (or --set statusLine true if already installed).`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Decision — pure
// ---------------------------------------------------------------------------

export interface StatusLineNudgeInputs {
  stats: StatsLite | null;
  firstRunAtMs: number | null;
  statusLineConfigured: boolean;
  state: StatusLineNudgeState;
  nowMs: number;
}

export interface StatusLineNudgeResult {
  nudgeText: string | null;
  /** Reason it didn't fire (for telemetry / debug). */
  reason?:
    | "fired"
    | "no_stats"
    | "below_min_calls"
    | "status_line_configured"
    | "outside_discovery_window"
    | "already_fired";
}

export function computeStatusLineNudge(
  inputs: StatusLineNudgeInputs,
): StatusLineNudgeResult {
  // Already fired once — never re-fire.
  if (inputs.state.last_status_line_nudge_at > 0) {
    return { nudgeText: null, reason: "already_fired" };
  }
  // Status line already configured (or explicitly opted out).
  if (inputs.statusLineConfigured) {
    return { nudgeText: null, reason: "status_line_configured" };
  }
  // No stats file: brand-new install with no calls yet.
  if (inputs.stats === null) {
    return { nudgeText: null, reason: "no_stats" };
  }
  if (inputs.stats.lifetimeCalls < STATUS_LINE_MIN_CALLS) {
    return { nudgeText: null, reason: "below_min_calls" };
  }
  // 24h discovery window — only fire while the user is fresh. If we
  // have no firstRunAt at all, fall through (means session-state.json
  // is missing; we still treat the user as fresh).
  if (inputs.firstRunAtMs !== null) {
    const windowMs = STATUS_LINE_WINDOW_HOURS * 60 * 60_000;
    if (inputs.nowMs - inputs.firstRunAtMs > windowMs) {
      return { nudgeText: null, reason: "outside_discovery_window" };
    }
  }
  return {
    nudgeText: buildStatusLineNudge(inputs.stats.lifetimeTokensSaved),
    reason: "fired",
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — read state, scan files, emit, persist
// ---------------------------------------------------------------------------

export interface FireResult {
  nudgeText: string | null;
  reason?: StatusLineNudgeResult["reason"];
}

export function checkAndFireStatusLineNudge(
  homeDir: string = homedir(),
  nowMs: number = Date.now(),
): FireResult {
  try {
    const stats = readStatsLite(homeDir);
    const firstRunAtMs = readFirstRunAtMs(homeDir);
    const statusLineConfigured = isStatusLineConfigured(homeDir);
    const state = readStatusLineNudgeState(homeDir);

    const result = computeStatusLineNudge({
      stats,
      firstRunAtMs,
      statusLineConfigured,
      state,
      nowMs,
    });

    if (result.nudgeText) {
      writeStatusLineNudgeState(
        { last_status_line_nudge_at: nowMs },
        homeDir,
      );
    }

    return { nudgeText: result.nudgeText, reason: result.reason };
  } catch {
    return { nudgeText: null };
  }
}

// ---------------------------------------------------------------------------
// CLI entry — invoked by session-end-consolidate.ts
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { nudgeText } = checkAndFireStatusLineNudge();
  if (nudgeText) {
    process.stdout.write("\n" + nudgeText + "\n");
  }
  process.exit(0);
}
