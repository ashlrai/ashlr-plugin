#!/usr/bin/env bun
/**
 * posttooluse-native-nudge.ts — PostToolUse hook: missed-save nudge.
 *
 * Fires AFTER a native Read / Grep / Edit / Write / MultiEdit call completes.
 * When the tool was called on a file inside cwd (and not inside the plugin
 * tree) that COULD have been redirected by ashlr but wasn't (either because
 * ASHLR_HOOK_MODE=nudge or because the cwd-clamp let it through), this hook
 * emits a `additionalContext` nudge into the next assistant turn.
 *
 * Two escalation levels:
 *   1. Basic missed-save nudge (first time, throttled to 1/min):
 *        [ashlr nudge] You called native Read on big_file.ts (8.2KB).
 *        ashlr__read would have returned ~1.6KB. Try
 *        mcp__plugin_ashlr_ashlr__ashlr__read next time.
 *
 *   2. Repeat-offender escalation (3+ calls of same tool in 10 min):
 *        [ashlr nudge] You've called native Grep 3 times in the last
 *        10 minutes. ashlr__grep would have saved ~80% on each. Set
 *        ASHLR_HOOK_MODE=redirect to enforce the swap automatically:
 *        `bun ${CLAUDE_PLUGIN_ROOT}/scripts/set-hook-mode.ts redirect`.
 *
 * Constraints:
 *   - Only fires in ASHLR_HOOK_MODE=nudge. In redirect mode the PreToolUse
 *     hook already blocked and explained — double-talk is annoying.
 *   - Only fires for in-cwd, non-plugin-tree files (mirrors PreToolUse guard).
 *   - Throttled to ≤1 nudge per 60 seconds (see _nudge-throttle.ts).
 *   - Kill switch: ASHLR_SESSION_LOG=0.
 *   - Best-effort: any error → exit 0, no nudge.
 *
 * PostToolUse hook contract:
 *   stdin  → JSON { tool_name, tool_input: { ... }, tool_response: { ... } }
 *   stdout → JSON { hookSpecificOutput: { hookEventName: "PostToolUse",
 *                     additionalContext: "..." } }   (nudge)
 *             OR empty / "{}" (no nudge)
 *   exit 0 always (never block post-tool execution)
 */

import { basename } from "path";
import {
  flushHookTimings,
  fileSize,
  getHookMode,
  isInsideCwd,
  isInsidePluginRoot,
  parsePayload,
  pluginRootFrom,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";
import { recordNativeCall } from "./_nudge-throttle";

const hookStartedAt = Date.now();

// Kill switch
if (process.env.ASHLR_SESSION_LOG === "0") {
  process.stdout.write("{}");
  process.exit(0);
}

async function exit(code: number, outcome: "ok" | "error" = "ok"): Promise<never> {
  recordHookTiming({
    hook: "posttooluse-native-nudge",
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
  await flushHookTimings();
  process.exit(code);
}

// Tool → ashlr equivalent mapping
const NATIVE_TO_ASHLR: Record<string, { ashlrTool: string; mcpTool: string; savingsPct: number }> = {
  Read:      { ashlrTool: "ashlr__read",       mcpTool: "mcp__plugin_ashlr_ashlr__ashlr__read",       savingsPct: 80 },
  Grep:      { ashlrTool: "ashlr__grep",       mcpTool: "mcp__plugin_ashlr_ashlr__ashlr__grep",       savingsPct: 80 },
  Edit:      { ashlrTool: "ashlr__edit",       mcpTool: "mcp__plugin_ashlr_ashlr__ashlr__edit",       savingsPct: 60 },
  Write:     { ashlrTool: "ashlr__edit",       mcpTool: "mcp__plugin_ashlr_ashlr__ashlr__edit",       savingsPct: 60 },
  MultiEdit: { ashlrTool: "ashlr__multi_edit", mcpTool: "mcp__plugin_ashlr_ashlr__ashlr__multi_edit", savingsPct: 60 },
};

const READ_THRESHOLD = 2048; // bytes — mirrors pretooluse-read.ts

// Parse stdin
const raw = await readStdin();
let payload: Record<string, unknown> = {};
try {
  payload = JSON.parse(raw) as Record<string, unknown>;
} catch {
  process.stdout.write("{}");
  await exit(0);
}

const toolName = payload.tool_name as string | undefined;
if (!toolName) {
  process.stdout.write("{}");
  await exit(0);
}

const equiv = NATIVE_TO_ASHLR[toolName as string];
if (!equiv) {
  process.stdout.write("{}");
  await exit(0);
}

// Only fire in nudge mode — redirect mode already blocked + explained.
const mode = getHookMode();
if (mode !== "nudge") {
  process.stdout.write("{}");
  await exit(0);
}

// Extract file path from tool_input
const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
const filePath = (toolInput.file_path as string | undefined)
  ?? (toolInput.path as string | undefined)
  ?? "";

// For Read: only nudge on files above the threshold (tiny reads have no savings).
if (toolName === "Read") {
  if (!filePath) {
    process.stdout.write("{}");
    await exit(0);
  }
  const size = fileSize(filePath);
  if (size === null || size <= READ_THRESHOLD) {
    process.stdout.write("{}");
    await exit(0);
  }
}

// For Grep: always try (no size guard needed).
// For Edit/Write/MultiEdit: only nudge when filePath is present.
if ((toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") && !filePath) {
  process.stdout.write("{}");
  await exit(0);
}

// Safety: only nudge for in-cwd, non-plugin-tree paths.
const pluginRoot = pluginRootFrom(import.meta.url);
if (filePath) {
  if (isInsidePluginRoot(filePath, pluginRoot)) {
    process.stdout.write("{}");
    await exit(0);
  }
  if (!isInsideCwd(filePath)) {
    process.stdout.write("{}");
    await exit(0);
  }
}

// Throttle check + repeat-offender detection.
const { emitNudge, emitEscalation, recentCallCount } = recordNativeCall(toolName as string);

if (!emitNudge && !emitEscalation) {
  process.stdout.write("{}");
  await exit(0);
}

// Build the nudge message.
let nudgeText: string;
const pluginRoot2 = process.env.CLAUDE_PLUGIN_ROOT ?? pluginRoot;

if (emitEscalation) {
  nudgeText =
    `[ashlr nudge] You've called native ${toolName} ${recentCallCount} times in the last 10 minutes. ` +
    `${equiv.ashlrTool} would have saved ~${equiv.savingsPct}% on each. ` +
    `Set ASHLR_HOOK_MODE=redirect to enforce the swap automatically: ` +
    `\`bun ${pluginRoot2}/scripts/set-hook-mode.ts redirect\`.`;
} else {
  // Basic missed-save nudge — include size hint for Read.
  if (toolName === "Read" && filePath) {
    const size = fileSize(filePath);
    const sizeKb = size !== null ? (size / 1024).toFixed(1) + "KB" : "large file";
    const compactKb = size !== null
      ? ((size * (1 - equiv.savingsPct / 100)) / 1024).toFixed(1) + "KB"
      : "much less";
    const fname = basename(filePath) || filePath;
    nudgeText =
      `[ashlr nudge] You called native Read on ${fname} (${sizeKb}). ` +
      `${equiv.ashlrTool} would have returned ~${compactKb}. ` +
      `Try ${equiv.mcpTool} next time.`;
  } else if (toolName === "Grep") {
    const pattern = (toolInput.pattern as string | undefined) ?? "<pattern>";
    nudgeText =
      `[ashlr nudge] You called native Grep. ` +
      `${equiv.ashlrTool} would have saved ~${equiv.savingsPct}% (genome-aware retrieval or truncated ripgrep). ` +
      `Try ${equiv.mcpTool} with { "pattern": ${JSON.stringify(pattern)} } next time.`;
  } else {
    const fname = filePath ? (basename(filePath) || filePath) : "<file>";
    nudgeText =
      `[ashlr nudge] You called native ${toolName} on ${fname}. ` +
      `${equiv.ashlrTool} would have saved ~${equiv.savingsPct}% by returning only a compact diff. ` +
      `Try ${equiv.mcpTool} next time.`;
  }
}

const output = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: nudgeText,
  },
};

process.stdout.write(JSON.stringify(output));
await exit(0);
