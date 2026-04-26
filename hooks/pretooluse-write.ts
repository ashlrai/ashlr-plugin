#!/usr/bin/env bun
/**
 * pretooluse-write.ts — PreToolUse hook for the Write tool (new-file creation).
 *
 * v1.22 (Track C): covers the Write tool for cases where ashlr__write provides
 * compression benefit. The key distinction:
 *
 *   - Write on a NON-EXISTENT path (new-file creation): pass through.
 *     ashlr__write on a new file still avoids echoing content, but since Claude
 *     Code's native Write for a new file doesn't echo content back either, the
 *     savings differential is minimal — don't block the agent.
 *
 *   - Write on an EXISTING file (full rewrite): redirect to ashlr__write.
 *     Native Write echoes the full new content back; ashlr__write delegates to
 *     ashlr__edit (diff format) — ~80% token savings on large files.
 *
 * Note: The existing pretooluse-edit.ts hook also fires for Write (via its
 * "Edit|Write|MultiEdit" matcher) and handles large existing files. This hook
 * specifically targets Write with a Write-focused redirect message pointing at
 * ashlr__write rather than ashlr__edit. The two hooks can coexist — each
 * provides a redirect; Claude Code will use the first deny it sees.
 *
 * Size threshold: same 5KB as pretooluse-edit (smaller files: savings don't
 * materialize, pass through to avoid friction).
 */

import {
  buildPassThrough,
  buildRedirectBlock,
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

const THRESHOLD = 5120;
const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-write", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const tool = payload!.tool_name || undefined;
if (payload!.tool_name !== "Write") await exit(0, "ok", tool);
if (!payload!.file_path) await exit(0, "ok", tool);
if (payload!.bypass) await exit(0, "bypass", tool);

const pluginRoot = pluginRootFrom(import.meta.url);
if (isInsidePluginRoot(payload!.file_path, pluginRoot)) await exit(0, "ok", tool);

const mode = getHookMode();
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}

// Nudge mode: soft suggestion for existing files only. New-file Write never nudged.
if (mode === "nudge") {
  const size = fileSize(payload!.file_path);
  if (size === null) {
    // New file — pass through silently.
    process.stdout.write(JSON.stringify(buildPassThrough()));
    await exit(0, "ok", tool);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] You're rewriting an existing file with the built-in Write tool. ` +
          `Prefer \`ashlr__write\` — it delegates to ashlr__edit (diff format) for ` +
          `existing files, returning only a compact diff summary instead of the full new content. ` +
          `Call it with { "filePath": "${payload!.file_path}", "content": "..." }.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

// Redirect mode: only redirect existing files above the size threshold.
const size = fileSize(payload!.file_path);
if (size === null) {
  // New file — not compressible, pass through.
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}
if (size! <= THRESHOLD) await exit(0, "ok", tool);

// Outside cwd: nudge only, don't block.
if (!isInsideCwd(payload!.file_path)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] You're rewriting an existing file with the built-in Write tool. ` +
          `Prefer \`ashlr__write\` for compact diff output. ` +
          `Call it with { "filePath": "${payload!.file_path}", "content": "..." }.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

const mcp = "mcp__plugin_ashlr_ashlr__ashlr__write";
const reason =
  `[ashlr] To bypass: set ASHLR_HOOK_MODE=nudge in ~/.ashlr/config.json. ` +
  `Current rule: blocking built-in Write on ${payload!.file_path} (${size} bytes) — ` +
  `call ${mcp} instead, which delegates to ashlr__edit (diff format) for existing ` +
  `files and returns only a compact diff summary, avoiding the full content echo ` +
  `(~80% token savings on files this size). ` +
  `Equivalent call: { "filePath": "${payload!.file_path}", "content": "..." }.`;
process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
await exit(0, "block", tool);
