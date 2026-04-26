#!/usr/bin/env bun
/**
 * pretooluse-websearch.ts — PreToolUse hook for the WebSearch tool.
 *
 * In redirect mode (default) this hook BLOCKS the native WebSearch call and
 * routes the agent to ashlr__websearch, which deduplicates results by domain,
 * truncates snippets to ~500 chars, and synthesizes a 1-paragraph summary.
 *
 * Set `ASHLR_HOOK_MODE=nudge` to downgrade to a soft suggestion.
 * Set `ASHLR_HOOK_MODE=off` (or `~/.ashlr/settings.json { toolRedirect: false }`)
 * for total pass-through.
 */

import {
  buildNudgeContext,
  buildPassThrough,
  buildRedirectBlock,
  flushHookTimings,
  getHookMode,
  parsePayload,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-websearch", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "WebSearch") await exit(0, "ok", tool);
if (payload!.bypass) await exit(0, "bypass", tool);

const mode = getHookMode();
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}

// Extract query from the raw payload for the redirect message.
let query = "<query>";
try {
  const parsed = JSON.parse(raw) as { tool_input?: { query?: string } };
  if (typeof parsed?.tool_input?.query === "string") query = parsed.tool_input.query;
} catch {
  /* ignore */
}

if (mode === "nudge") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] Prefer the MCP tool \`ashlr__websearch\` over the built-in WebSearch. ` +
          `It deduplicates results by domain, truncates snippets to ~500 chars, and synthesizes ` +
          `a 1-paragraph summary when more than 3 results are returned — saving 40-80% tokens. ` +
          `Call it with { "query": ${JSON.stringify(query)} }.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

// Default: redirect mode — block and route to ashlr__websearch.
const safeQuery = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const reason =
  `[ashlr] Blocking the built-in WebSearch. Call ` +
  `mcp__plugin_ashlr_ashlr__ashlr__websearch instead — it deduplicates results ` +
  `by domain, truncates snippets to ~500 chars, and synthesizes a 1-paragraph ` +
  `summary for result sets > 3 entries. ` +
  `Equivalent call: { "query": "${safeQuery}" }. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
await exit(0, "block", tool);
