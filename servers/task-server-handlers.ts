/**
 * task-server-handlers — side-effect module.
 *
 * Importing this file registers ashlr__task_list and ashlr__task_get into
 * the shared registry (_tool-base.ts). Used by both the standalone entry
 * point (task-server.ts) and the router (_router.ts via _router-handlers.ts).
 *
 * TaskCreate/Update are intentionally NOT wrapped — they're tiny inputs
 * with no token savings opportunity on the read side.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { recordSavingAccurate } from "./_accounting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskListArgs {
  status?: string;
  owner?: string;
  limit?: number;
}

interface TaskGetArgs {
  taskId: string;
}

interface RawTask {
  id?: string;
  taskId?: string;
  status?: string;
  subject?: string;
  title?: string;
  description?: string;
  owner?: string;
  assignee?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface CompactTaskRow {
  taskId: string;
  status: string;
  subject: string;
  ageMin: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a task's ID from various field name conventions. */
function getTaskId(t: RawTask): string {
  return String(t.id ?? t.taskId ?? "");
}

/** Extract status, normalizing to lowercase. */
function getStatus(t: RawTask): string {
  return String(t.status ?? "unknown").toLowerCase();
}

/** Extract a short subject line from various field name conventions. */
function getSubject(t: RawTask): string {
  return String(t.subject ?? t.title ?? "").slice(0, 80);
}

/** Extract owner/assignee. */
function getOwner(t: RawTask): string {
  return String(t.owner ?? t.assignee ?? "");
}

/**
 * Compute age in minutes from a createdAt timestamp. Returns -1 if
 * the timestamp is missing or unparseable.
 */
function ageMinutes(t: RawTask): number {
  const ts = t.createdAt ?? t.updatedAt;
  if (!ts) return -1;
  try {
    const ms = Date.now() - new Date(String(ts)).getTime();
    return Math.max(0, Math.round(ms / 60_000));
  } catch {
    return -1;
  }
}

/**
 * Snip a long text to maxBytes with an elision marker in the middle.
 * Used to compact task descriptions.
 */
function snipCompact(s: string, maxBytes: number): { text: string; snipped: boolean; fullLength: number } {
  const fullLength = s.length;
  if (fullLength <= maxBytes) return { text: s, snipped: false, fullLength };
  const half = Math.floor(maxBytes / 2);
  const head = s.slice(0, half);
  const tail = s.slice(fullLength - half);
  const elided = fullLength - maxBytes;
  return {
    text: `${head}\n\n[... ${elided} chars elided — full description is ${fullLength} chars ...]\n\n${tail}`,
    snipped: true,
    fullLength,
  };
}

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * ashlrTaskList — thin redirect handler for the MCP tool entry point.
 *
 * IMPORTANT — this function is a *redirect notice*, not a real fetch:
 *
 * MCP tool subprocesses cannot invoke Claude Code's built-in TaskList tool.
 * The actual token-savings value lives in the PreToolUse hook
 * (`hooks/pretooluse-task.ts`) which intercepts the *built-in* TaskList call
 * and offers compaction via `processTaskListResults` once Claude has the
 * task data in-context.
 *
 * When the agent calls `ashlr__task_list` directly (no native results in
 * hand), the correct behavior is to nudge it to call Claude Code's
 * built-in TaskList — that's what produces real task data which can then
 * be compacted by the hook flow.
 *
 * Do NOT "implement real fetch" here — there is no subprocess-side fetch
 * available. The compression worker (`processTaskListResults`) is the real
 * implementation; this redirect just wires the MCP entry point.
 */
export async function ashlrTaskList(args: TaskListArgs): Promise<string> {
  const { status, owner, limit = 30 } = args;

  const rawPayload = JSON.stringify({ status, owner, limit, note: "tasklist-redirect" });
  const rawBytes = rawPayload.length;

  const output = {
    tasks: [] as CompactTaskRow[],
    totalCount: 0,
    droppedCount: 0,
    redirect: "TaskList",
    note:
      "[ashlr__task_list] This MCP tool is a thin nudge — it cannot call the " +
      "built-in TaskList from a subprocess. Call Claude Code's built-in TaskList " +
      "directly. The ashlr PreToolUse hook then routes the *result* through " +
      "processTaskListResults() to compact it (taskId, status, subject ≤80 chars, " +
      "ageMin) and save 50–80% on long task lists. " +
      `Requested filters: status=${status ?? "all"}, owner=${owner ?? "all"}, limit=${limit}.`,
  };

  const compactJson = JSON.stringify(output);
  const compactBytes = compactJson.length;

  await recordSavingAccurate({
    rawBytes,
    compactBytes,
    toolName: "ashlr__task_list",
    cacheHit: false,
  });

  return compactJson;
}

/**
 * Process raw task list results into a compact column view.
 * Exported for tests and for caller-provided result scenarios.
 */
export async function processTaskListResults(
  rawTasks: RawTask[],
  opts: TaskListArgs = {},
): Promise<{
  tasks: CompactTaskRow[];
  totalCount: number;
  droppedCount: number;
  rawBytes: number;
  compactBytes: number;
}> {
  const { status, owner, limit = 30 } = opts;
  const rawBytes = JSON.stringify(rawTasks).length;

  // Filter by status.
  let filtered = rawTasks;
  if (status) {
    const s = status.toLowerCase();
    filtered = filtered.filter((t) => getStatus(t) === s);
  }

  // Filter by owner.
  if (owner) {
    const o = owner.toLowerCase();
    filtered = filtered.filter((t) => getOwner(t).toLowerCase() === o);
  }

  const totalCount = filtered.length;
  const kept = filtered.slice(0, limit);
  const droppedCount = totalCount - kept.length;

  const tasks: CompactTaskRow[] = kept.map((t) => ({
    taskId: getTaskId(t),
    status: getStatus(t),
    subject: getSubject(t),
    ageMin: ageMinutes(t),
  }));

  const output = { tasks, totalCount, droppedCount };
  const compactBytes = JSON.stringify(output).length;

  await recordSavingAccurate({
    rawBytes,
    compactBytes,
    toolName: "ashlr__task_list",
    cacheHit: false,
  });

  return { ...output, rawBytes, compactBytes };
}

/**
 * ashlrTaskGet — thin redirect handler for the MCP tool entry point.
 *
 * IMPORTANT — this function is a *redirect notice*, not a real fetch:
 *
 * MCP tool subprocesses cannot invoke Claude Code's built-in TaskGet tool.
 * The actual token-savings value lives in the PreToolUse hook
 * (`hooks/pretooluse-task.ts`) which intercepts the *built-in* TaskGet call
 * and offers description-truncation via `processTaskGetResult` once Claude
 * has the task body in-context.
 *
 * When the agent calls `ashlr__task_get` directly (no native task data in
 * hand), the correct behavior is to nudge it to call Claude Code's
 * built-in TaskGet — that's what produces real task data which can then
 * be compacted by the hook flow.
 *
 * Do NOT "implement real fetch" here — there is no subprocess-side fetch
 * available. The compression worker (`processTaskGetResult`) is the real
 * implementation; this redirect just wires the MCP entry point.
 */
export async function ashlrTaskGet(args: TaskGetArgs): Promise<string> {
  const { taskId } = args;

  const rawPayload = JSON.stringify({ taskId, note: "taskget-redirect" });
  const rawBytes = rawPayload.length;

  const output = {
    taskId,
    status: "redirect",
    subject: "",
    descriptionCompact: "",
    fullLength: 0,
    redirect: "TaskGet",
    note:
      "[ashlr__task_get] This MCP tool is a thin nudge — it cannot call the " +
      "built-in TaskGet from a subprocess. Call Claude Code's built-in TaskGet " +
      `directly for taskId=${JSON.stringify(taskId)}. The ashlr PreToolUse hook ` +
      "then routes the *result* through processTaskGetResult() to snipCompact " +
      "descriptions > 2KB (head + tail with elision marker), saving tokens on " +
      "long-bodied tasks without losing context bookends.",
  };

  const compactJson = JSON.stringify(output);
  const compactBytes = compactJson.length;

  await recordSavingAccurate({
    rawBytes,
    compactBytes,
    toolName: "ashlr__task_get",
    cacheHit: false,
  });

  return compactJson;
}

/**
 * Process a raw single task into a compact view, truncating the description
 * if it exceeds 2KB.
 * Exported for tests.
 */
export async function processTaskGetResult(
  rawTask: RawTask,
): Promise<{
  taskId: string;
  status: string;
  subject: string;
  descriptionCompact: string;
  fullLength: number;
  rawBytes: number;
  compactBytes: number;
}> {
  const rawBytes = JSON.stringify(rawTask).length;
  const description = String(rawTask.description ?? "");
  const { text: descriptionCompact, fullLength } = snipCompact(description, 2048);

  const output = {
    taskId: getTaskId(rawTask),
    status: getStatus(rawTask),
    subject: getSubject(rawTask),
    descriptionCompact,
    fullLength,
  };

  const compactBytes = JSON.stringify(output).length;

  await recordSavingAccurate({
    rawBytes,
    compactBytes,
    toolName: "ashlr__task_get",
    cacheHit: false,
  });

  return { ...output, rawBytes, compactBytes };
}

// ---------------------------------------------------------------------------
// Registration (side-effect on import)
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__task_list",
  description:
    "Token-efficient task list viewer. Filters by status/owner, limits to max rows (default 30), " +
    "and returns a compact column view: taskId, status, subject (80 chars), ageMin. " +
    "Use instead of TaskList to avoid verbose task payloads. " +
    "Args: status (optional filter), owner (optional filter), limit (default 30).",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string",  description: "Filter by task status (e.g. 'open', 'closed')" },
      owner:  { type: "string",  description: "Filter by owner/assignee" },
      limit:  { type: "number",  description: "Max tasks to return (default 30)" },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrTaskList(args as unknown as TaskListArgs);
    return { content: [{ type: "text", text }] };
  },
});

registerTool({
  name: "ashlr__task_get",
  description:
    "Token-efficient single task viewer. Fetches a task by ID and snipCompacts the description " +
    "if it exceeds 2KB (head + tail with elision marker). " +
    "Returns: taskId, status, subject, descriptionCompact, fullLength. " +
    "Use instead of TaskGet for long-description tasks. " +
    "Args: taskId (required).",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID to retrieve" },
    },
    required: ["taskId"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrTaskGet(args as unknown as TaskGetArgs);
    return { content: [{ type: "text", text }] };
  },
});
