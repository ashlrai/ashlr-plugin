#!/usr/bin/env bun
/**
 * ashlr edit-batching-nudge PostToolUse hook.
 *
 * Watches consecutive Edit / ashlr__edit calls and, once the agent has made
 * more than N edits inside a short rolling window, emits an additionalContext
 * nudge suggesting that multiple edits to the same file be batched into a
 * single call (which saves ~40% tokens vs. multiple round-trips).
 *
 * State lives in ~/.ashlr/edit-batch.json:
 *   {
 *     "pid": 12345,                  // session-scoped: resets when PID changes
 *     "timestamps": [171000.., ...]  // unix-ms timestamps of recent edits
 *   }
 *
 * Hook contract (PostToolUse):
 *   stdin  → { tool_name, tool_input?, ... }
 *   stdout → { hookSpecificOutput: { hookEventName: "PostToolUse",
 *                                    additionalContext?: string } }
 *
 * Design rules:
 *   - Never throw. Malformed input or fs errors → silent pass-through.
 *   - Only trigger on Edit and ashlr__edit. Anything else → pass-through.
 *   - Threshold: > 3 edits within 60 seconds. The 4th edit fires the nudge.
 *     (3 is small enough to catch genuine spam; large enough to not annoy on
 *     normal multi-step refactors.)
 *   - After firing once we keep counting, but the nudge naturally re-fires
 *     only after the window resets — so the agent isn't spammed every call.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const EDIT_TOOL_NAMES = new Set(["Edit", "ashlr__edit"]);
export const WINDOW_MS = 60_000;
export const NUDGE_THRESHOLD = 3; // > 3 within window → nudge

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface BatchState {
  pid: number;
  timestamps: number[];
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
  return join(home, ".ashlr", "edit-batch.json");
}

export function loadState(path: string, currentPid: number): BatchState {
  try {
    if (!existsSync(path)) return { pid: currentPid, timestamps: [] };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<BatchState>;
    if (typeof raw.pid !== "number" || raw.pid !== currentPid) {
      return { pid: currentPid, timestamps: [] };
    }
    const ts = Array.isArray(raw.timestamps)
      ? raw.timestamps.filter((n): n is number => typeof n === "number")
      : [];
    return { pid: currentPid, timestamps: ts };
  } catch {
    return { pid: currentPid, timestamps: [] };
  }
}

export function saveState(path: string, state: BatchState): void {
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
  if (!name || !EDIT_TOOL_NAMES.has(name)) return passThrough();

  const home = opts.home ?? homedir();
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const path = statePath(home);

  const state = loadState(path, pid);
  // Drop timestamps outside the rolling window, then record this edit.
  const fresh = state.timestamps.filter((t) => now - t <= WINDOW_MS);
  fresh.push(now);
  const next: BatchState = { pid, timestamps: fresh };
  saveState(path, next);

  if (fresh.length > NUDGE_THRESHOLD) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[ashlr] You've made ${fresh.length} single-file edits in the last minute. ` +
          `If you're editing the same file multiple times, batch them into a single ` +
          `edit (or use ashlr__edit with a multi-hunk patch) for a ~40% token saving.`,
      },
    };
  }
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
