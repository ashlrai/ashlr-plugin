#!/usr/bin/env bun
/**
 * pretooluse-read.ts — Cross-platform replacement for pretooluse-read.sh.
 *
 * v1.18: by default, this hook BLOCKS the native Read tool for files larger
 * than the snipCompact threshold and routes the agent to ashlr__read instead
 * ("redirect" mode). Set `ASHLR_HOOK_MODE=nudge` to fall back to a soft
 * `additionalContext` suggestion (the old v1.17 tool-redirect.ts behavior,
 * since absorbed into this hook after tool-redirect.ts was retired). Set
 * `ASHLR_HOOK_MODE=off` — or `~/.ashlr/settings.json { toolRedirect: false }`
 * — for total pass-through with no nudge at all.
 *
 * Contract (Claude Code PreToolUse):
 *   stdin  -> JSON { tool_name, tool_input: { file_path, ... }, ... }
 *   stdout -> JSON { hookSpecificOutput: {
 *                      hookEventName: "PreToolUse",
 *                      permissionDecision: "deny",
 *                      permissionDecisionReason: "..."
 *                    } }                       (redirect mode, blocks)
 *   stdout -> JSON { hookSpecificOutput: {
 *                      hookEventName: "PreToolUse",
 *                      additionalContext: "..."
 *                    } }                       (nudge mode)
 *   stdout -> JSON { hookSpecificOutput: { hookEventName: "PreToolUse" } }
 *                                              (off mode / pass-through)
 *   exit 0 -> allow / proceed (with stdout JSON above, if any)
 *   exit 2 -> legacy block (stderr is shown as a tool error). Only taken
 *             when `ASHLR_ENFORCE=1` is set — preserved for back-compat with
 *             harness configurations and the hook-timings test suite.
 *
 * Safety: we never block on files outside `cwd` or inside CLAUDE_PLUGIN_ROOT.
 * Those fall through to a silent pass-through even in redirect mode, so the
 * agent can edit/read plugin internals and other-project files without being
 * rerouted into ashlr__*.
 */

import {
  buildNudgeContext,
  buildPassThrough,
  buildRedirectBlock,
  enforcementDisabled,
  fileSize,
  flushHookTimings,
  getHookMode,
  isInsideCwd,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const THRESHOLD = 2048;
const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-read", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "Read") await exit(0, "ok", tool);
if (!payload!.file_path) await exit(0, "ok", tool);
if (payload!.bypass) await exit(0, "bypass", tool);

const pluginRoot = pluginRootFrom(import.meta.url);
// Never redirect reads inside the plugin's own tree — agents editing the
// ashlr-plugin itself need direct access without being rerouted.
if (isInsidePluginRoot(payload!.file_path, pluginRoot)) await exit(0, "ok", tool);

const size = fileSize(payload!.file_path);
if (size === null) await exit(0, "ok", tool);
if (size! <= THRESHOLD) await exit(0, "ok", tool);

// Legacy back-compat: `ASHLR_ENFORCE=1` → exit-code-based block on stderr.
if (!enforcementDisabled()) {
  const savedTokens = Math.max(0, Math.floor((size! - 1024) / 4));
  process.stderr.write(
    `ashlr: refusing full Read of ${payload!.file_path} (${size} bytes). Call ashlr__read instead for snipCompact truncation — saves ~${savedTokens} tokens. Pass bypassSummary: true on ashlr__read if you truly need the raw file. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  await exit(2, "block", tool);
}

// v1.18: default redirect mode. Fall back to nudge when the file lies
// outside cwd (e.g. /tmp, unrelated repos) — we only block paths the user
// has actually brought into scope.
const mode = getHookMode();
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}
if (mode === "nudge" || !isInsideCwd(payload!.file_path)) {
  const nudge = buildNudgeContext("Read", { file_path: payload!.file_path });
  process.stdout.write(JSON.stringify(nudge ?? buildPassThrough()));
  await exit(0, "ok", tool);
}

const reason =
  `[ashlr] Blocking the built-in Read on ${payload!.file_path} (${size} bytes). ` +
  `Call mcp__plugin_ashlr_ashlr__ashlr__read instead — it returns a ` +
  `snipCompact-truncated view (head + tail, elided middle) and typically ` +
  `saves ~${Math.max(0, Math.floor((size! - 1024) / 4))} tokens for a file this size. ` +
  `Equivalent call: { "path": "${payload!.file_path}" }. ` +
  `Pass bypassSummary: true on ashlr__read if you truly need the full file. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
await exit(0, "block", tool);
