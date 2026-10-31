/** Read-only job inspection. Job metadata never supplies a file path to open. */
import { homedir } from "node:os";
import { join } from "node:path";
import { jobChildren } from "./_job-lifecycle";
import { readFleetJobsText, readFleetText } from "./fleet-state-server-handlers";
import { registerTool } from "./_tool-base";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function redact(text: string): string {
  return text
    .replace(/\b(?:Bearer\s+)[^\s"'\\,;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:["']?(?:[\w-]*(?:token|secret|password|api[_-]?key))["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, "[REDACTED]");
}
function failure(error: unknown): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
  return error instanceof SyntaxError ? "invalid" : error instanceof Error && ["unsafe", "too_large", "invalid"].includes(error.message) ? error.message : "unavailable";
}

export function fleetSession(jobId: string, root = join(homedir(), ".ashlr", "fleet"), offset?: number) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new Error("invalid job_id");
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error("invalid offset");
  let nextOffset = offset ?? 0, reset = false, hasMore = false;
  const errors: Record<string, string> = {};
  let job: Record<string, unknown> | null = null;
  const records: Record<string, unknown>[] = [];
  try {
    for (const line of readFleetJobsText(root).split("\n").filter(line => line.trim())) {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
      records.push(value);
      if (value.id === jobId || value.job_id === jobId) job = value;
    }
  } catch (error) { job = null; records.length = 0; errors.job = failure(error); }
  if (!job && !errors.job) errors.job = "missing";
  // Live children of this job: last-wins parent links over the same stream.
  const children = records.length ? jobChildren(records, jobId) : [];
  let logs: string[] | null = null;
  try {
    const text = readFleetText(root, `logs/${jobId}.log`);
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (offset === undefined) logs = lines.slice(-150).map(redact);
    else {
      // A truncated file starts a fresh tail; offsets count complete physical lines.
      if (lines.at(-1) !== undefined && !text.endsWith("\n")) lines.pop();
      reset = offset > lines.length;
      const start = reset ? 0 : offset;
      nextOffset = Math.min(lines.length, start + 150);
      hasMore = nextOffset < lines.length;
      logs = lines.slice(start, nextOffset).map(redact);
    }
  } catch (error) { errors.logs = failure(error); }
  // Redact the whole response, including nested metrics and metadata strings.
  return JSON.parse(JSON.stringify({ job_id: jobId, job, children, metrics: job?.metrics ?? null,
    ...(offset === undefined ? {} : { offset: nextOffset, reset, has_more: hasMore }),
    pr_url: job?.pr_url ?? job?.prUrl ?? null, worktree: job?.worktree ?? null, logs, errors }, (key, value) => /token|secret|password|api[_-]?key/i.test(key) ? "[REDACTED]" : typeof value === "string" ? redact(value) : value));
}

registerTool({
  name: "ashlr__fleet_session",
  description: "Read a fleet job's latest metadata and metrics, its live children (jobs whose parent_job_id names it), PR URL, worktree and last 150 log lines from ~/.ashlr/fleet/jobs.jsonl (or ~/.ashlr-runs/metrics/jobs.jsonl when the fleet log is absent) and logs/<job_id>.log. Token-like strings are redacted; missing or unsafe files are reported. Read-only; accepts a job ID, never a path.",
  inputSchema: { type: "object", properties: { job_id: { type: "string", pattern: JOB_ID.source, maxLength: 128 } }, required: ["job_id"], additionalProperties: false },
  handler: async (args) => {
    if (Object.keys(args).some(key => key !== "job_id") || typeof args.job_id !== "string" || !JOB_ID.test(args.job_id)) {
      return { isError: true, content: [{ type: "text", text: "fleet_session requires a valid job_id and no other arguments" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(fleetSession(args.job_id)) }] };
  },
});
