#!/usr/bin/env bun
/**
 * pretooluse-webfetch.ts — PreToolUse hook for the WebFetch tool.
 *
 * WebFetch has no ashlr__* equivalent. This hook provides audit-trail
 * coverage so every WebFetch call appears in hook-timings.jsonl. In nudge
 * mode it reminds the agent that ashlr__webfetch compresses large HTML
 * responses, returning only the main content with the boilerplate stripped.
 *
 * Never blocks in any mode — WebFetch is a read-only network tool and the
 * agent must always be able to fetch documentation or API responses.
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
  recordHookTiming({ hook: "pretooluse-webfetch", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "WebFetch") await exit(0, "ok", tool);

const mode = getHookMode();
if (mode === "nudge") {
  let url = "<url>";
  try {
    const parsed = JSON.parse(raw) as { tool_input?: { url?: string } };
    if (typeof parsed?.tool_input?.url === "string") url = parsed.tool_input.url;
  } catch {
    /* ignore */
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] Prefer the MCP tool \`ashlr__webfetch\` over the built-in WebFetch. ` +
          `It strips HTML boilerplate and returns only the main content, saving tokens ` +
          `on documentation pages and API references. ` +
          `Call it with { "url": ${JSON.stringify(url)} }.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

process.stdout.write(JSON.stringify(buildPassThrough()));
await exit(0, "ok", tool);
