#!/usr/bin/env bun
/**
 * pretooluse-glob.ts — PreToolUse hook for the Glob tool.
 *
 * Glob has no direct ashlr__* equivalent, so this hook never blocks.
 * Its purpose is audit-trail coverage: every Glob invocation is logged to
 * hook-timings.jsonl so `/ashlr-hook-timings` shows a complete picture of
 * all built-in tool activity, not just Read/Grep/Edit.
 *
 * In nudge mode we emit a soft `additionalContext` reminding the agent that
 * ashlr__grep can serve many of the same discovery use-cases with genome-
 * aware ranking. In redirect and off modes we pass through silently.
 */

import {
  buildPassThrough,
  flushHookTimings,
  getHookMode,
  parsePayload,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-glob", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "Glob") await exit(0, "ok", tool);

const mode = getHookMode();
if (mode === "nudge") {
  // Soft suggestion: ashlr__grep can handle many Glob-like discovery queries
  // with genome-aware ranking when a genome exists.
  let pattern = "*";
  try {
    const parsed = JSON.parse(raw) as { tool_input?: { pattern?: string } };
    if (typeof parsed?.tool_input?.pattern === "string") pattern = parsed.tool_input.pattern;
  } catch {
    /* ignore */
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] For file discovery with ranking, consider \`ashlr__grep\` — ` +
          `when .ashlrcode/genome/ exists it returns the most relevant sections ` +
          `instead of a flat glob list. Pattern: ${JSON.stringify(pattern)}.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

// redirect or off: pass through silently (Glob has no ashlr equivalent to
// block toward; audit trail is captured via the timing record above).
process.stdout.write(JSON.stringify(buildPassThrough()));
await exit(0, "ok", tool);
