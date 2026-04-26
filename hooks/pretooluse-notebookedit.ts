#!/usr/bin/env bun
/**
 * pretooluse-notebookedit.ts — PreToolUse hook for the NotebookEdit tool.
 *
 * v1.22 (Track C): promoted from audit-only to redirect. The redirect target
 * `ashlr__notebook_edit` now exists and returns a compressed cell-window
 * response instead of echoing the full notebook state.
 *
 * Redirect applies only when:
 *   - hook mode is "redirect" (default)
 *   - the notebook path is inside cwd (same safety rule as pretooluse-edit)
 *
 * Pass-through when:
 *   - hook mode is "nudge" or "off"
 *   - path is outside cwd (can't redirect safely)
 *   - NotebookEdit is called on a non-existent file (edge case, let Claude Code handle it)
 */

import {
  buildNudgeContext,
  buildPassThrough,
  buildRedirectBlock,
  flushHookTimings,
  getHookMode,
  isInsideCwd,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
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
if (payload!.bypass) await exit(0, "bypass", tool);

// NotebookEdit uses `notebook_path` in its input — check both field names for
// robustness since the harness payload shape may vary across Claude Code versions.
const rawInput = (() => {
  try {
    const p = JSON.parse(raw);
    return p?.tool_input ?? {};
  } catch {
    return {};
  }
})();
const notebookPath: string =
  typeof rawInput.notebook_path === "string"
    ? rawInput.notebook_path
    : typeof rawInput.file_path === "string"
      ? rawInput.file_path
      : "";

const pluginRoot = pluginRootFrom(import.meta.url);
if (isInsidePluginRoot(notebookPath, pluginRoot)) await exit(0, "ok", tool);

const mode = getHookMode();
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}

if (mode === "nudge") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] For notebook cell edits, prefer \`ashlr__notebook_edit\` — ` +
          `it applies the edit and returns only the edited cell and its immediate neighbors ` +
          `instead of echoing the full notebook state.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

// redirect mode: block and route to ashlr__notebook_edit.
if (!notebookPath || !isInsideCwd(notebookPath)) {
  // Outside cwd or path unknown — nudge only, don't block.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] For notebook cell edits, prefer \`ashlr__notebook_edit\` — ` +
          `it returns only a cell-window summary instead of the full notebook.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

const mcp = "mcp__plugin_ashlr_ashlr__ashlr__notebook_edit";
const reason =
  `[ashlr] To bypass: set ASHLR_HOOK_MODE=nudge in ~/.ashlr/config.json. ` +
  `Current rule: blocking built-in NotebookEdit on ${notebookPath || "<notebook>"} — ` +
  `call ${mcp} instead, which applies the cell edit and returns only the edited cell ` +
  `plus one cell above and below (full notebook never echoed). ` +
  `Equivalent call: { "notebookPath": "${notebookPath}", "cellIndex": <n>, "newSource": "..." }.`;
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
await exit(0, "block", tool);
