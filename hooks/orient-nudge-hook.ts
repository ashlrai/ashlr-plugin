#!/usr/bin/env bun
/**
 * ashlr orient-nudge PostToolUse hook.
 *
 * Detects the "orientation" anti-pattern: 3+ Read/Grep calls inside a rolling
 * 60s window without an intervening Edit/Write. When detected, nudges the
 * agent to use the `ashlr__orient` tool, which folds tree scan + grep +
 * selective reads into a single synthesized call.
 *
 * State lives in ~/.ashlr/orient-state.json:
 *   {
 *     "pid": 12345,                  // session-scoped: resets when PID changes
 *     "events": [{ "tool": "Read", "at": 171.. }, ...],
 *     "lastNudgeAt": 171..            // unix-ms of last nudge (for debounce)
 *   }
 *
 * Hook contract (PostToolUse):
 *   stdin  → { tool_name, tool_input?, ... }
 *   stdout → { hookSpecificOutput: { hookEventName: "PostToolUse",
 *                                    additionalContext?: string } }
 *
 * Trigger:
 *   - On Edit/Write/ashlr__edit: clear events (user is now editing, not
 *     orienting). Never nudges on these.
 *   - On Read/Grep/ashlr__read/ashlr__grep: append event, prune to last 60s.
 *     If window has ≥3 events AND we haven't nudged in past 5 minutes → nudge.
 *     Note: we fire regardless of whether the grep returned results — the
 *     signal is "agent is scanning" not "agent found something". That's the
 *     whole point: empty greps are the most expensive kind of orienting.
 *
 * Debounce: after firing, set lastNudgeAt; suppress further nudges for 5 min
 * even if the agent keeps Read/Grep'ing. The window continues filling up so
 * once the 5min elapses, if they're still orienting, they get nudged again.
 *
 * Opt-out: { "ashlr": { "orientNudge": false } } in ~/.claude/settings.json.
 *
 * Design rules:
 *   - Never throw. Malformed input, fs errors, malformed settings → pass-through.
 *   - Only Read/Grep/ashlr__read/ashlr__grep append events. Edit/Write/
 *     ashlr__edit clear. Other tools → pass-through untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const READ_TOOL_NAMES = new Set([
  "Read",
  "Grep",
  "mcp__ashlr-efficiency__ashlr__read",
  "mcp__ashlr-efficiency__ashlr__grep",
  "mcp__plugin_ashlr_ashlr__ashlr__read",
  "mcp__plugin_ashlr_ashlr__ashlr__grep",
  "ashlr__read",
  "ashlr__grep",
]);

export const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "mcp__ashlr-efficiency__ashlr__edit",
  "mcp__plugin_ashlr_ashlr__ashlr__edit",
  "mcp__plugin_ashlr_ashlr__ashlr__multi_edit",
  "mcp__plugin_ashlr_ashlr__ashlr__edit_structural",
  "ashlr__edit",
]);

export const WINDOW_MS = 60_000;
export const NUDGE_THRESHOLD = 3;
export const DEBOUNCE_MS = 5 * 60_000;

export const NUDGE_MESSAGE =
  "[ashlr] You've done 3+ Read/Grep calls in the last minute without editing. " +
  "If you're orienting, try `ashlr__orient` with a natural-language query — " +
  "it runs a tree scan + grep + selective reads in one call with a synthesized answer.";

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface OrientEvent {
  tool: string;
  at: number;
}

export interface OrientState {
  pid: number;
  events: OrientEvent[];
  lastNudgeAt?: number;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
}

export function passThrough(): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
}

export function statePath(home: string = homedir()): string {
  return join(home, ".ashlr", "orient-state.json");
}

export function settingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export function isOptedOut(home: string = homedir()): boolean {
  try {
    const p = settingsPath(home);
    if (!existsSync(p)) return false;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      ashlr?: { orientNudge?: unknown };
    };
    return raw?.ashlr?.orientNudge === false;
  } catch {
    return false;
  }
}

export function loadState(path: string, currentPid: number): OrientState {
  try {
    if (!existsSync(path)) return { pid: currentPid, events: [] };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<OrientState>;
    if (typeof raw.pid !== "number" || raw.pid !== currentPid) {
      return { pid: currentPid, events: [] };
    }
    const events = Array.isArray(raw.events)
      ? raw.events.filter(
          (e): e is OrientEvent =>
            !!e &&
            typeof (e as OrientEvent).tool === "string" &&
            typeof (e as OrientEvent).at === "number",
        )
      : [];
    const lastNudgeAt =
      typeof raw.lastNudgeAt === "number" ? raw.lastNudgeAt : undefined;
    return { pid: currentPid, events, lastNudgeAt };
  } catch {
    return { pid: currentPid, events: [] };
  }
}

export function saveState(path: string, state: OrientState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // best effort — never throw out of the hook
  }
}

export interface DecideOpts {
  home?: string;
  pid?: number;
  now?: number;
}

export function decide(
  payload: PostToolUsePayload,
  opts: DecideOpts = {},
): HookOutput {
  const name = payload?.tool_name;
  if (!name) return passThrough();

  const home = opts.home ?? homedir();
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();

  if (isOptedOut(home)) return passThrough();

  const path = statePath(home);
  const state = loadState(path, pid);

  // Edit/Write tools end the orientation phase — clear events.
  if (EDIT_TOOL_NAMES.has(name)) {
    saveState(path, { pid, events: [], lastNudgeAt: state.lastNudgeAt });
    return passThrough();
  }

  // Not a tool we care about.
  if (!READ_TOOL_NAMES.has(name)) return passThrough();

  // Prune stale events and record this one.
  const fresh = state.events.filter((e) => now - e.at <= WINDOW_MS);
  fresh.push({ tool: name, at: now });

  const debounced =
    typeof state.lastNudgeAt === "number" &&
    now - state.lastNudgeAt < DEBOUNCE_MS;

  if (fresh.length >= NUDGE_THRESHOLD && !debounced) {
    saveState(path, { pid, events: fresh, lastNudgeAt: now });
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: NUDGE_MESSAGE,
      },
    };
  }

  saveState(path, { pid, events: fresh, lastNudgeAt: state.lastNudgeAt });
  return passThrough();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  let payload: PostToolUsePayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as PostToolUsePayload;
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
