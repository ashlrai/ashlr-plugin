#!/usr/bin/env bun
/**
 * pretooluse-read.ts — Cross-platform replacement for pretooluse-read.sh.
 *
 * v1.18: by default, this hook BLOCKS the native Read tool for files larger
 * than the snipCompact threshold and routes the agent to ashlr__read instead
 * ("redirect" mode). Set `ASHLR_HOOK_MODE=nudge` to restore the v1.17 silent
 * pass-through behavior and let tool-redirect.ts inject a soft suggestion
 * instead.
 *
 * Contract (Claude Code PreToolUse):
 *   stdin  -> JSON { tool_name, tool_input: { file_path, ... }, ... }
 *   stdout -> JSON { hookSpecificOutput: {
 *                      hookEventName: "PreToolUse",
 *                      permissionDecision: "deny",
 *                      permissionDecisionReason: "..."
 *                    } }                       (redirect mode, blocks)
 *   stdout -> JSON { hookSpecificOutput: { hookEventName: "PreToolUse" } }
 *                                              (nudge mode, pass-through)
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
  buildPassThrough,
  buildRedirectBlock,
  enforcementDisabled,
  fileSize,
  getHookMode,
  isInsideCwd,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

const THRESHOLD = 2048;

// Record how long this hook took regardless of which exit branch fires.
const hookStartedAt = Date.now();
let observedTool: string | undefined;
let outcome: "ok" | "bypass" | "block" | "error" = "ok";
process.on("exit", (code) => {
  if (outcome === "ok" && code === 2) outcome = "block";
  recordHookTiming({
    hook: "pretooluse-read",
    tool: observedTool,
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
});

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) process.exit(0);

observedTool = payload.tool_name || undefined;
if (payload.tool_name !== "Read") process.exit(0);
if (!payload.file_path) process.exit(0);
if (payload.bypass) {
  outcome = "bypass";
  process.exit(0);
}

const pluginRoot = pluginRootFrom(import.meta.url);
// Never redirect reads inside the plugin's own tree — agents editing the
// ashlr-plugin itself need direct access without being rerouted.
if (isInsidePluginRoot(payload.file_path, pluginRoot)) process.exit(0);

const size = fileSize(payload.file_path);
if (size === null) process.exit(0);
if (size <= THRESHOLD) process.exit(0);

// Legacy back-compat: `ASHLR_ENFORCE=1` → exit-code-based block on stderr.
// This path predates the v1.18 redirect mode and is preserved so existing
// harness configs and the hook-timings tests behave identically.
if (!enforcementDisabled()) {
  const savedTokens = Math.max(0, Math.floor((size - 1024) / 4));
  process.stderr.write(
    `ashlr: refusing full Read of ${payload.file_path} (${size} bytes). Call ashlr__read instead for snipCompact truncation — saves ~${savedTokens} tokens. Pass bypassSummary: true on ashlr__read if you truly need the raw file. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
}

// v1.18: default redirect mode. Fall back to nudge when the file lies
// outside cwd (e.g. /tmp, unrelated repos) — we only block paths the user
// has actually brought into scope.
const mode = getHookMode();
if (mode === "nudge" || !isInsideCwd(payload.file_path)) {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  process.exit(0);
}

const reason =
  `[ashlr] Blocking the built-in Read on ${payload.file_path} (${size} bytes). ` +
  `Call mcp__plugin_ashlr_ashlr__ashlr__read instead — it returns a ` +
  `snipCompact-truncated view (head + tail, elided middle) and typically ` +
  `saves ~${Math.max(0, Math.floor((size - 1024) / 4))} tokens for a file this size. ` +
  `Equivalent call: { "path": "${payload.file_path}" }. ` +
  `Pass bypassSummary: true on ashlr__read if you truly need the full file. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
outcome = "block";
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
process.exit(0);
