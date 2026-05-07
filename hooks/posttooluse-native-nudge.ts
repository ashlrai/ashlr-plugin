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
  nudgeVariantIndex,
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

/** No-nudge pass-through — write empty JSON and exit 0. */
async function passThrough(): Promise<never> {
  process.stdout.write("{}");
  await exit(0);
  // unreachable; satisfies `never` return type
  throw new Error("unreachable");
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
  await passThrough();
}

const toolName = payload.tool_name as string | undefined;
if (!toolName) await passThrough();

const equiv = NATIVE_TO_ASHLR[toolName as string];
if (!equiv) await passThrough();

// Only fire in nudge mode — redirect mode already blocked + explained.
if (getHookMode() !== "nudge") await passThrough();

// Extract file path from tool_input
const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
const filePath = (toolInput.file_path as string | undefined)
  ?? (toolInput.path as string | undefined)
  ?? "";

// For Read: only nudge on files above the threshold (tiny reads have no savings).
if (toolName === "Read") {
  if (!filePath) await passThrough();
  const size = fileSize(filePath);
  if (size === null || size <= READ_THRESHOLD) await passThrough();
}

// For Grep: always try (no size guard needed).
// For Edit/Write/MultiEdit: only nudge when filePath is present.
if ((toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") && !filePath) {
  await passThrough();
}

// Safety: only nudge for in-cwd, non-plugin-tree paths.
const pluginRoot = pluginRootFrom(import.meta.url);
if (filePath) {
  if (isInsidePluginRoot(filePath, pluginRoot)) await passThrough();
  if (!isInsideCwd(filePath)) await passThrough();
}

// Throttle check + repeat-offender detection.
const { emitNudge, emitEscalation, recentCallCount } = recordNativeCall(toolName as string);

if (!emitNudge && !emitEscalation) await passThrough();

// Build the nudge message.
let nudgeText: string;
const pluginRoot2 = process.env.CLAUDE_PLUGIN_ROOT ?? pluginRoot;

if (emitEscalation) {
  // Escalation: 3+ same-tool calls in 10 min — give actionable set-hook-mode instruction.
  const escalationVariants = [
    `[ashlr nudge] ${recentCallCount}x native ${toolName} in 10 min — ${equiv.ashlrTool} saves ~${equiv.savingsPct}% each. ` +
      `Enforce: \`bun ${pluginRoot2}/scripts/set-hook-mode.ts redirect\`.`,
    `[ashlr nudge] You've used native ${toolName} ${recentCallCount} times (last 10 min). ` +
      `${equiv.mcpTool} would save ~${equiv.savingsPct}% per call. ` +
      `Auto-redirect: \`bun ${pluginRoot2}/scripts/set-hook-mode.ts redirect\`.`,
    `[ashlr nudge] ${recentCallCount} native ${toolName} calls = missed savings. ` +
      `Set ASHLR_HOOK_MODE=redirect or run \`bun ${pluginRoot2}/scripts/set-hook-mode.ts redirect\` once.`,
  ];
  nudgeText = escalationVariants[nudgeVariantIndex(`${toolName}:${recentCallCount}`, escalationVariants.length)];
} else {
  // Basic missed-save nudge — include exact size + MCP tool name to call.
  if (toolName === "Read" && filePath) {
    const size = fileSize(filePath);
    const sizeKb = size !== null ? (size / 1024).toFixed(1) + "KB" : "?KB";
    const compactKb = size !== null
      ? ((size * (1 - equiv.savingsPct / 100)) / 1024).toFixed(1) + "KB"
      : "~20%";
    const fname = basename(filePath) || filePath;
    const variants = [
      `[ashlr nudge] ${fname} (${sizeKb}) — ${equiv.mcpTool} returns ~${compactKb} instead. Call it next time.`,
      `[ashlr nudge] Native Read on ${fname} (${sizeKb}) costs ${equiv.savingsPct}% extra tokens. ` +
        `Use ${equiv.mcpTool} { "path": "${filePath}" }.`,
      `[ashlr nudge] ${equiv.ashlrTool} on ${fname}: ${sizeKb} → ~${compactKb}. ` +
        `${equiv.mcpTool} { "path": "${filePath}" }.`,
    ];
    nudgeText = variants[nudgeVariantIndex(filePath, variants.length)];
  } else if (toolName === "Grep") {
    const pattern = (toolInput.pattern as string | undefined) ?? "<pattern>";
    const variants = [
      `[ashlr nudge] ${equiv.mcpTool} saves ~${equiv.savingsPct}% on Grep (genome-aware or compressed rg). ` +
        `{ "pattern": ${JSON.stringify(pattern)} }.`,
      `[ashlr nudge] Native Grep → raw output. ${equiv.ashlrTool} filters to relevant chunks (~${equiv.savingsPct}% smaller). ` +
        `${equiv.mcpTool} { "pattern": ${JSON.stringify(pattern)} }.`,
      `[ashlr nudge] Use ${equiv.mcpTool} instead of Grep — genome routing or truncated ripgrep, ~${equiv.savingsPct}% savings.`,
    ];
    nudgeText = variants[nudgeVariantIndex(pattern, variants.length)];
  } else {
    // Edit / Write / MultiEdit
    const fname = filePath ? (basename(filePath) || filePath) : "<file>";
    const variants = [
      `[ashlr nudge] ${equiv.mcpTool} on ${fname} returns only a diff (~${equiv.savingsPct}% less than native ${toolName}).`,
      `[ashlr nudge] Native ${toolName} echoes the full file; ${equiv.ashlrTool} returns compact diff only. ` +
        `Try ${equiv.mcpTool} { "path": "${filePath}" }.`,
      `[ashlr nudge] ${fname} — ${equiv.ashlrTool} saves ~${equiv.savingsPct}% by returning a diff summary. ` +
        `${equiv.mcpTool} { "path": "${filePath}", "search": ..., "replace": ... }.`,
    ];
    nudgeText = variants[nudgeVariantIndex(filePath || fname, variants.length)];
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
