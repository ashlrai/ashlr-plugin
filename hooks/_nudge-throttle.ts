/**
 * _nudge-throttle.ts — Per-tool nudge throttle for posttooluse-native-nudge.
 *
 * Contract: at most 1 missed-save nudge per minute (across all tools) and
 * at most 1 repeat-offender escalation per minute. State is persisted to
 * ~/.ashlr/nudge-throttle.json so the limit crosses hook subprocess
 * boundaries (each PostToolUse invocation is a fresh process).
 *
 * Design:
 *   - Best-effort only. Any I/O error → silent continue (fail open).
 *   - Kill switch: ASHLR_SESSION_LOG=0 disables nudges.
 *   - File: ~/.ashlr/nudge-throttle.json — written synchronously so it
 *     completes before process.exit().
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const THROTTLE_MS = 60_000; // 1 nudge per minute
export const REPEAT_WINDOW_MS = 10 * 60_000; // 10-minute repeat-offender window
export const REPEAT_THRESHOLD = 3; // calls before escalation

export interface ThrottleState {
  /** Epoch ms of the last nudge emitted (any tool). */
  lastNudgeAt: number;
  /** Epoch ms of the last repeat-offender escalation. */
  lastEscalationAt: number;
  /**
   * Per-tool call timestamps within the repeat window.
   * Only tracks native calls that COULD have been redirected.
   */
  recentCalls: Record<string, number[]>; // toolName → array of epoch ms
}

function throttlePath(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".ashlr", "nudge-throttle.json");
}

function readState(home?: string): ThrottleState {
  try {
    const p = throttlePath(home);
    if (!existsSync(p)) {
      return { lastNudgeAt: 0, lastEscalationAt: 0, recentCalls: {} };
    }
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ThrottleState>;
    return {
      lastNudgeAt: typeof raw.lastNudgeAt === "number" ? raw.lastNudgeAt : 0,
      lastEscalationAt: typeof raw.lastEscalationAt === "number" ? raw.lastEscalationAt : 0,
      recentCalls: (raw.recentCalls && typeof raw.recentCalls === "object")
        ? raw.recentCalls as Record<string, number[]>
        : {},
    };
  } catch {
    return { lastNudgeAt: 0, lastEscalationAt: 0, recentCalls: {} };
  }
}

function writeState(state: ThrottleState, home?: string): void {
  try {
    const p = throttlePath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state), "utf-8");
  } catch {
    // Best-effort.
  }
}

export interface NudgeDecision {
  /** Whether to emit a basic missed-save nudge. */
  emitNudge: boolean;
  /** Whether to escalate to a repeat-offender message instead. */
  emitEscalation: boolean;
  /** How many recent native calls exist for this tool (for escalation message). */
  recentCallCount: number;
}

/**
 * Record a native tool call and decide whether to emit a nudge.
 *
 * @param toolName  - e.g. "Read", "Grep", "Edit"
 * @param now       - injectable for testing (default: Date.now())
 * @param home      - injectable for testing
 */
export function recordNativeCall(
  toolName: string,
  now: number = Date.now(),
  home?: string,
): NudgeDecision {
  if (process.env.ASHLR_SESSION_LOG === "0") {
    return { emitNudge: false, emitEscalation: false, recentCallCount: 0 };
  }

  const state = readState(home);

  // Prune old entries from recentCalls for this tool.
  const cutoff = now - REPEAT_WINDOW_MS;
  const prev = (state.recentCalls[toolName] ?? []).filter((t) => t >= cutoff);
  prev.push(now);
  state.recentCalls[toolName] = prev;

  const recentCallCount = prev.length;
  const timeSinceLastNudge = now - state.lastNudgeAt;
  const timeSinceLastEscalation = now - state.lastEscalationAt;

  let emitNudge = false;
  let emitEscalation = false;

  if (recentCallCount >= REPEAT_THRESHOLD && timeSinceLastEscalation >= THROTTLE_MS) {
    // Repeat offender — escalate.
    emitEscalation = true;
    state.lastEscalationAt = now;
    state.lastNudgeAt = now; // also resets nudge throttle
  } else if (timeSinceLastNudge >= THROTTLE_MS) {
    // Simple missed-save nudge.
    emitNudge = true;
    state.lastNudgeAt = now;
  }

  writeState(state, home);
  return { emitNudge, emitEscalation, recentCallCount };
}
