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
 * ashlrTaskList — compact column view of task list results.
 *
 * In the hook-redirect flow the PreToolUse hook blocks TaskList and routes
 * the agent here. Since MCP tools cannot invoke native Claude Code tools
 * directly as subprocesses, we explain the redirect contract and return a
 * structured placeholder. The agent should pass in results if available.
 */
export async function ashlrTaskList(args: TaskListArgs): Promise<string> {
  const { status, owner, limit = 30 } = args;

  const rawPayload = JSON.stringify({ status, owner, limit, note: "tasklist-redirect-stub" });
  const rawBytes = rawPayload.length;

  const output = {
    tasks: [] as CompactTaskRow[],
    totalCount: 0,
    droppedCount: 0,
    note:
      "[ashlr__task_list] TaskList results are not directly accessible from an MCP tool subprocess. " +
      "This tool compresses TaskList output when invoked via the hook redirect path. " +
      "If you have task list results to compress, pass them to processTaskListResults(). " +
      `Filters applied: status=${status ?? "all"}, owner=${owner ?? "all"}, limit=${limit}.`,
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
 * ashlrTaskGet — compact view of a single task with description truncation.
 */
export async function ashlrTaskGet(args: TaskGetArgs): Promise<string> {
  const { taskId } = args;

  const rawPayload = JSON.stringify({ taskId, note: "taskget-redirect-stub" });
  const rawBytes = rawPayload.length;

  const output = {
    taskId,
    status: "unknown",
    subject: "",
    descriptionCompact: "",
    fullLength: 0,
    note:
      "[ashlr__task_get] TaskGet results are not directly accessible from an MCP tool subprocess. " +
      "This tool compresses TaskGet output when invoked via the hook redirect path. " +
      `Task ID requested: ${taskId}.`,
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
