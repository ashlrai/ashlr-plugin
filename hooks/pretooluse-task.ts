#!/usr/bin/env bun
/**
 * pretooluse-task.ts — PreToolUse hook for TaskList and TaskGet tools.
 *
 * In redirect mode (default) this hook BLOCKS the native TaskList/TaskGet
 * calls and routes the agent to ashlr__task_list / ashlr__task_get, which
 * filter, paginate, and truncate task payloads to save tokens.
 *
 * TaskCreate and TaskUpdate are NOT intercepted — they're tiny inputs.
 *
 * Escape valves (in order of granularity):
 *   - `ASHLR_TASK_PASSTHROUGH=1` env — pass through TaskList/TaskGet for this
 *     invocation only. Use from skills like `/deep-work` that orchestrate
 *     many subagents and need the raw, full task list.
 *   - `~/.ashlr/settings.json { "hookModes": { "task": "nudge" } }` — soft
 *     suggestion instead of block, permanently.
 *   - `ASHLR_HOOK_MODE=nudge` env — same as above but global (all hooks).
 *   - `ASHLR_HOOK_MODE=off` (or `settings.json { toolRedirect: false }`) —
 *     total pass-through, all hooks.
 */

import {
  buildPassThrough,
  buildRedirectBlock,
  flushHookTimings,
  getHookModeFor,
  installHookTimeout,
  parsePayload,
  readStdin,
  recordHookTiming,
} from "./pretooluse-common";

if (import.meta.main) installHookTimeout("pretooluse-task");

const hookStartedAt = Date.now();

async function exit(code: number, outcome: "ok" | "bypass" | "block" | "error", tool?: string): Promise<never> {
  recordHookTiming({ hook: "pretooluse-task", tool, durationMs: Date.now() - hookStartedAt, outcome });
  await flushHookTimings();
  process.exit(code);
}

const raw = await readStdin();
const payload = parsePayload(raw);
if (!payload) await exit(0, "ok");

const toolName = payload!.tool_name;
const tool = toolName || undefined;

if (toolName !== "TaskList" && toolName !== "TaskGet") await exit(0, "ok", tool);
if (payload!.bypass) await exit(0, "bypass", tool);

// Per-invocation escape valve. Skills that legitimately need the full task
// list (e.g. multi-agent orchestrators like /deep-work) can set this in their
// prelude before issuing TaskList/TaskGet.
if (process.env.ASHLR_TASK_PASSTHROUGH === "1") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "bypass", tool);
}

const mode = getHookModeFor("task");
if (mode === "off") {
  process.stdout.write(JSON.stringify(buildPassThrough()));
  await exit(0, "ok", tool);
}

// Parse tool input for a more helpful redirect message.
let taskId = "<taskId>";
let status = "<status>";
try {
  const parsed = JSON.parse(raw) as { tool_input?: { task_id?: string; taskId?: string; status?: string } };
  const input = parsed?.tool_input ?? {};
  if (typeof input.task_id === "string") taskId = input.task_id;
  if (typeof input.taskId === "string") taskId = input.taskId;
  if (typeof input.status === "string") status = input.status;
} catch {
  /* ignore */
}

if (mode === "nudge") {
  const ashlrTool = toolName === "TaskList" ? "ashlr__task_list" : "ashlr__task_get";
  const exampleCall =
    toolName === "TaskList"
      ? `{ "status": ${JSON.stringify(status !== "<status>" ? status : undefined)} }`
      : `{ "taskId": ${JSON.stringify(taskId)} }`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[ashlr] Prefer the MCP tool \`${ashlrTool}\` over the built-in ${toolName}. ` +
          (toolName === "TaskList"
            ? "It filters by status/owner, limits to 30 rows by default, and returns a compact column view (taskId, status, subject, ageMin). "
            : "It snipCompacts descriptions > 2KB and returns a compact structured view. ") +
          `Call it with ${exampleCall}.`,
      },
    }),
  );
  await exit(0, "ok", tool);
}

// Default: redirect mode.
const escapeValves =
  `Escape valves: ASHLR_TASK_PASSTHROUGH=1 (one-shot pass-through, ` +
  `intended for skills like /deep-work that need the full list); ` +
  `~/.ashlr/settings.json { "hookModes": { "task": "nudge" } } (soft hint ` +
  `instead of block); ASHLR_HOOK_MODE=nudge (global soft hint).`;

let reason: string;
if (toolName === "TaskList") {
  const safeStatus = status.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  reason =
    `[ashlr] Blocking the built-in TaskList. Call ` +
    `mcp__plugin_ashlr_ashlr__ashlr__task_list instead — it filters by status/owner, ` +
    `limits to 30 rows by default, and returns a compact column view (taskId, status, ` +
    `subject, ageMin) saving 50-80% tokens on large task lists. ` +
    `Equivalent call: { "status": "${safeStatus}" }. ` +
    escapeValves;
} else {
  const safeTaskId = taskId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  reason =
    `[ashlr] Blocking the built-in TaskGet. Call ` +
    `mcp__plugin_ashlr_ashlr__ashlr__task_get instead — it snipCompacts descriptions ` +
    `> 2KB (head + tail with elision marker) to save tokens on tasks with long bodies. ` +
    `Equivalent call: { "taskId": "${safeTaskId}" }. ` +
    escapeValves;
}

process.stdout.write(JSON.stringify(buildRedirectBlock(reason)));
await exit(0, "block", tool);
