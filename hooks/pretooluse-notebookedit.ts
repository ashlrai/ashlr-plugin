#!/usr/bin/env bun
/**
 * pretooluse-notebookedit.ts — PreToolUse hook for the NotebookEdit tool.
 *
 * NotebookEdit has no direct ashlr__* equivalent. This hook provides
 * audit-trail coverage so every notebook edit appears in hook-timings.jsonl,
 * and in nudge mode it reminds the agent that ashlr__edit_structural can
 * handle cell-level edits with a diff-summary response.
 *
 * Never blocks — NotebookEdit is a write tool with no safe redirect target.
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
  recordHookTiming({ hook: "pretooluse-notebookedit", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "NotebookEdit") await exit(0, "ok", tool);

const mode = getHookMode();
if (mode === "nudge") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] For targeted notebook cell edits, consider \`ashlr__edit_structural\` — ` +
          `it returns a compact diff summary instead of echoing the full notebook state.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

process.stdout.write(JSON.stringify(buildPassThrough()));
await exit(0, "ok", tool);
