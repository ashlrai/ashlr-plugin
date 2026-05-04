#!/usr/bin/env bun
/**
 * pretooluse-eco-router.ts — Auto-route question-shaped Task calls to ashlr:ashlr:explore.
 *
 * PreToolUse hook. When ASHLR_ECO=1 and the Task tool is invoked without an
 * explicit subagent_type, AND the prompt starts with a question word, inject
 * subagent_type: "ashlr:ashlr:explore" into the tool input.
 *
 * Question word regex: /^(what|where|how|find|explain|why|which|when|who)\b/i
 *
 * If subagent_type is already set, passes through unchanged.
 * If ASHLR_ECO is not set or is "0", passes through unchanged.
 * If the tool is not "Task", passes through unchanged.
 *
 * Emits nudge event "eco_router_redirected" when a redirect occurs.
 *
 * Design:
 *   - Never blocks (always exits 0).
 *   - Best-effort stdin parse — falls through on any error.
 *
 * Hook contract (PreToolUse):
 *   stdin  → { tool_name, tool_input? }
 *   stdout → { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext? } }
 *             OR (when injecting): { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                                    toolInputOverride: { ...original_input, subagent_type: "ashlr:ashlr:explore" } } }
 */

import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext?: string;
    toolInputOverride?: Record<string, unknown>;
  };
}

interface Payload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUESTION_RE = /^(what|where|how|find|explain|why|which|when|who)\b/i;
const TARGET_SUBAGENT = "ashlr:ashlr:explore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passThrough(): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
}

function home(): string {
  return (
    process.env.ASHLR_HOME_OVERRIDE?.trim() ||
    process.env.HOME ||
    homedir()
  );
}

function emitRedirectEvent(): void {
  try {
    const p = join(home(), ".ashlr", "nudge-events.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "eco_router_redirected",
      subagent_type: TARGET_SUBAGENT,
    });
    appendFileSync(p, line + "\n", "utf-8");
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Core decision (exported for tests)
// ---------------------------------------------------------------------------

export interface RouteOpts {
  /** Override ASHLR_ECO env for testing. */
  ecoMode?: string;
}

export interface RouteResult {
  action: "pass" | "inject";
  subagent_type?: string;
  reason?: string;
}

export function route(payload: Payload, opts: RouteOpts = {}): RouteResult {
  const eco = opts.ecoMode ?? process.env.ASHLR_ECO;

  // Not in eco mode → pass.
  if (!eco || eco === "0") {
    return { action: "pass", reason: "eco_off" };
  }

  // Not a Task call → pass.
  if (payload.tool_name !== "Task") {
    return { action: "pass", reason: "not_task" };
  }

  const input = payload.tool_input ?? {};

  // Already has subagent_type → respect it, pass through.
  if (input.subagent_type != null) {
    return { action: "pass", reason: "subagent_already_set" };
  }

  // Check if the prompt is question-shaped.
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!QUESTION_RE.test(prompt)) {
    return { action: "pass", reason: "not_question_shaped" };
  }

  return { action: "inject", subagent_type: TARGET_SUBAGENT };
}

export function buildOutput(payload: Payload, result: RouteResult): HookOutput {
  if (result.action !== "inject") {
    return passThrough();
  }

  const overrideInput: Record<string, unknown> = {
    ...(payload.tool_input ?? {}),
    subagent_type: TARGET_SUBAGENT,
  };

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `[ashlr eco] Task routed to ${TARGET_SUBAGENT} (question-shaped prompt, eco mode on).`,
      toolInputOverride: overrideInput,
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
  let payload: Payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as Payload;
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
    process.exit(0);
  }

  try {
    const result = route(payload);
    if (result.action === "inject") {
      emitRedirectEvent();
    }
    process.stdout.write(JSON.stringify(buildOutput(payload, result)));
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
  }

  process.exit(0);
}

if (import.meta.main) {
  await main();
}
