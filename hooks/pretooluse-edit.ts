#!/usr/bin/env bun
/**
 * pretooluse-edit.ts — Cross-platform replacement for pretooluse-edit.sh.
 *
 * v1.18: by default, this hook BLOCKS the native Edit/Write/MultiEdit tools
 * for existing files larger than 5KB and routes the agent to the matching
 * ashlr__edit / ashlr__multi_edit MCP tool (diff-format, ~80% token savings).
 * Set `ASHLR_HOOK_MODE=nudge` to downgrade to a soft `additionalContext`
 * suggestion (the old v1.17 tool-redirect.ts behavior, absorbed into this
 * hook after tool-redirect.ts was retired). Set `ASHLR_HOOK_MODE=off` — or
 * `~/.ashlr/settings.json { toolRedirect: false }` — for total pass-through.
 *
 * v1.20.2: extended from Edit-only to Edit/Write/MultiEdit. The original
 * v1.18 build only matched "Edit", which left ~200 Write calls/day and the
 * MultiEdit volume completely unrouted. The new matcher in hooks.json fans
 * Edit|Write|MultiEdit into this hook, and the per-tool branch below maps
 * each to its ashlr__* equivalent. Write is special-cased: when the file
 * doesn't exist yet (new-file creation) there's no ashlr equivalent, so we
 * pass through silently rather than refuse.
 *
 * Edit-redirect carries more risk than read-redirect (write semantics), so
 * the hook is conservative:
 *   - Only redirects when file size > 5KB (built-in Edit is fine for small
 *     files; the diff-summary savings don't materialize until payloads grow).
 *   - Never redirects inside CLAUDE_PLUGIN_ROOT (agents edit plugin code).
 *   - Never redirects outside cwd (user didn't bring the path into scope).
 *   - Skips Write on a non-existent path (new-file creation, no equivalent).
 *
 * Legacy: `ASHLR_ENFORCE=1` continues to use the exit-2 + stderr protocol
 * for back-compat with existing harness configs and the hook-timings tests.
 */

import {
  buildNudgeContext,
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
const HANDLED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
if (!HANDLED_TOOLS.has(payload.tool_name)) process.exit(0);
if (!payload.file_path) process.exit(0);
if (payload.bypass) {
  outcome = "bypass";
  process.exit(0);
}

const pluginRoot = pluginRootFrom(import.meta.url);
// Never redirect edits inside the plugin's own tree — agents need direct
// access to modify plugin files without being rerouted into ashlr__edit.
if (isInsidePluginRoot(payload.file_path, pluginRoot)) process.exit(0);

// Per-tool redirect targets. The MCP-prefixed name is the canonical Claude
// Code tool name; the short name appears in the nudge fallback message.
const TOOL_TARGETS: Record<string, { mcp: string; short: string; verb: string }> = {
  Edit:      { mcp: "mcp__plugin_ashlr_ashlr__ashlr__edit",       short: "ashlr__edit",       verb: "Edit" },
  Write:     { mcp: "mcp__plugin_ashlr_ashlr__ashlr__edit",       short: "ashlr__edit",       verb: "Write" },
  MultiEdit: { mcp: "mcp__plugin_ashlr_ashlr__ashlr__multi_edit", short: "ashlr__multi_edit", verb: "MultiEdit" },
};
const target = TOOL_TARGETS[payload.tool_name]!;

// Resolve hook mode up-front. "off" short-circuits without touching the
// filesystem; "nudge" fires for every matched tool regardless of file size
// (matches the retired tool-redirect.ts behavior where Edit was always nudged).
const mode = getHookMode();
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  process.exit(0);
}
if (mode === "nudge") {
  // Port of the retired hooks/tool-redirect.ts nudge: soft suggestion only,
  // no permission decision. The built-in tool call proceeds unchanged. The
  // nudge builder for "Write" returns null on non-existent files (Write of
  // a new file has no ashlr equivalent), which falls through to passThrough.
  const nudge = buildNudgeContext(payload.tool_name, { file_path: payload.file_path });
  process.stdout.write(JSON.stringify(nudge ?? buildPassThrough()));
  process.exit(0);
}

const size = fileSize(payload.file_path);
// Write on a non-existent path = new-file creation. No ashlr equivalent
// (ashlr__edit needs a search string). Pass through silently — refusing
// would force the agent into a no-win loop with no fallback.
if (size === null) process.exit(0);
if (size <= THRESHOLD) process.exit(0);

// Legacy back-compat: `ASHLR_ENFORCE=1` → exit-code-based block on stderr.
if (!enforcementDisabled()) {
  process.stderr.write(
    `ashlr: refusing full ${target.verb} on large file ${payload.file_path} (${size} bytes). Call ${target.short} with diff-format to save ~80% tokens. Set ASHLR_NO_ENFORCE=1 to disable this guard.\n`,
  );
  process.exit(2);
}

// v1.18: default redirect mode. Fall back to nudge for paths outside cwd —
// never block on files the user didn't explicitly bring into scope.
if (!isInsideCwd(payload.file_path)) {
  const nudge = buildNudgeContext(payload.tool_name, { file_path: payload.file_path });
  process.stdout.write(JSON.stringify(nudge ?? buildPassThrough()));
  process.exit(0);
}

const callShape = payload.tool_name === "MultiEdit"
  ? `{ "edits": [{ "path": "${payload.file_path}", "search": "...", "replace": "..." }, ...] }`
  : `{ "path": "${payload.file_path}", "search": "...", "replace": "...", "strict": true }`;
const reason =
  `[ashlr] Blocking the built-in ${target.verb} on ${payload.file_path} (${size} bytes). ` +
  `Call ${target.mcp} instead — it applies an ` +
  `in-place strict-by-default search/replace and returns only a compact diff ` +
  `summary, avoiding the full file round-trip (~80% token savings on files ` +
  `this size). Equivalent call: ${callShape}. ` +
  `Set ASHLR_HOOK_MODE=nudge to downgrade this redirect to a soft suggestion.`;
outcome = "block";
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
process.exit(0);
