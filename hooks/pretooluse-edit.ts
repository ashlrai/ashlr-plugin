#!/usr/bin/env bun
/**
 * pretooluse-edit.ts — Cross-platform replacement for pretooluse-edit.sh.
 *
 * v1.18: by default, this hook BLOCKS the native Edit tool for files larger
 * than 5KB and routes the agent to ashlr__edit (diff-format, ~80% token
 * savings). Set `ASHLR_HOOK_MODE=nudge` to restore the v1.17 silent
 * pass-through behavior and let tool-redirect.ts inject a soft suggestion
 * instead.
 *
 * Edit-redirect carries more risk than read-redirect (write semantics), so
 * the hook is conservative:
 *   - Only redirects when file size > 5KB (built-in Edit is fine for small
 *     files; the diff-summary savings don't materialize until payloads grow).
 *   - Never redirects inside CLAUDE_PLUGIN_ROOT (agents edit plugin code).
 *   - Never redirects outside cwd (user didn't bring the path into scope).
 *
 * Legacy: `ASHLR_ENFORCE=1` continues to use the exit-2 + stderr protocol
 * for back-compat with existing harness configs and the hook-timings tests.
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

const THRESHOLD = 5120;

const hookStartedAt = Date.now();
let observedTool: string | undefined;
let outcome: "ok" | "bypass" | "block" | "error" = "ok";
process.on("exit", (code) => {
  if (outcome === "ok" && code === 2) outcome = "block";
  recordHookTiming({
    hook: "pretooluse-edit",
    tool: observedTool,
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
});

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) process.exit(0);

observedTool = payload.tool_name || undefined;
if (payload.tool_name !== "Edit") process.exit(0);
if (!payload.file_path) process.exit(0);
if (payload.bypass) {
  outcome = "bypass";
  process.exit(0);
}

const pluginRoot = pluginRootFrom(import.meta.url);
// Never redirect edits inside the plugin's own tree — agents need direct
// access to modify plugin files without being rerouted into ashlr__edit.
if (isInsidePluginRoot(payload.file_path, pluginRoot)) process.exit(0);

const size = fileSize(payload.file_path);
if (size === null) process.exit(0);
if (size <= THRESHOLD) process.exit(0);

// Legacy back-compat: `ASHLR_ENFORCE=1` → exit-code-based block on stderr.
if (!enforcementDisabled()) {
  process.stderr.write(
    `ashlr: refusing full Edit on large file ${payload.file_path} (${size} bytes). Call ashlr__edit with diff-format to save ~80% tokens. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
}

// v1.18: default redirect mode. Fall back to nudge for paths outside cwd —
// never block on files the user didn't explicitly bring into scope.
const mode = getHookMode();
if (mode === "nudge" || !isInsideCwd(payload.file_path)) {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  process.exit(0);
}

const reason =
  `[ashlr] Blocking the built-in Edit on ${payload.file_path} (${size} bytes). ` +
  `Call mcp__plugin_ashlr_ashlr__ashlr__edit instead — it applies an ` +
  `in-place strict-by-default search/replace and returns only a compact diff ` +
  `summary, avoiding the full file round-trip (~80% token savings on files ` +
  `this size). Equivalent call: ` +
  `{ "path": "${payload.file_path}", "search": "...", "replace": "...", "strict": true }. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
outcome = "block";
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
process.exit(0);
