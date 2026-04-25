#!/usr/bin/env bun
/**
 * pretooluse-bash.ts — Nudges the agent toward ashlr__bash for shell commands
 * that produce verbose output.
 *
 * Unlike pretooluse-{read,grep,edit}, this hook NEVER blocks regardless of
 * ASHLR_HOOK_MODE. Bash has no 1:1 equivalent for arbitrary commands —
 * forcing every shell call through MCP would strand the agent on commands
 * that aren't in the summarizer registry, and changes how output renders to
 * the user (MCP tool result vs. inline shell output). Nudge-only keeps the
 * UX intact while letting the model voluntarily pick ashlr__bash for the
 * commands where compression actually pays off.
 *
 * The nudge fires only when `findSummarizer(command)` returns non-null OR
 * `isLargeDiffCommand(command)` returns true — i.e., commands where
 * ashlr__bash would actually run a structured summarizer or LLM-compress the
 * stdout. Quiet commands (echo, pwd, mv, rm) pass through silently.
 *
 * `ASHLR_HOOK_MODE=off` (or the legacy `~/.ashlr/settings.json
 * { toolRedirect: false }` killswitch) disables the nudge entirely.
 */

import {
  buildNudgeContext,
  buildPassThrough,
  flushHookTimings,
  getHookMode,
  parsePayload,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-bash", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "Bash") await exit(0, "ok", tool);
if (!payload!.command) await exit(0, "ok", tool);

const mode = getHookMode();
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}

// buildNudgeContext("Bash", ...) returns null when the command isn't in the
// summarizer registry — passing through silently in that case is intentional.
const nudge = buildNudgeContext("Bash", { command: payload!.command });
process.stdout.write(JSON.stringify(nudge ?? buildPassThrough()));
await exit(0, "ok", tool);
