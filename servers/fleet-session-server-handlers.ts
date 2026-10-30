/** Read-only job inspection. Job metadata never supplies a file path to open. */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFleetText } from "./fleet-state-server-handlers";
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

export function fleetSession(jobId: string, root = join(homedir(), ".ashlr", "fleet")) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new Error("invalid job_id");
  const errors: Record<string, string> = {};
  let job: Record<string, unknown> | null = null;
  try {
    for (const line of readFleetText(root, "jobs.jsonl").split("\n").filter(line => line.trim())) {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
      if (value.id === jobId || value.job_id === jobId) job = value;
    }
  } catch (error) { job = null; errors.job = failure(error); }
  if (!job && !errors.job) errors.job = "missing";
  let logs: string[] | null = null;
  try {
    const lines = readFleetText(root, `logs/${jobId}.log`).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    logs = lines.slice(-150).map(redact);
  } catch (error) { errors.logs = failure(error); }
  // Redact the whole response, including nested metrics and metadata strings.
  return JSON.parse(JSON.stringify({ job_id: jobId, job, metrics: job?.metrics ?? null,
    pr_url: job?.pr_url ?? job?.prUrl ?? null, worktree: job?.worktree ?? null, logs, errors }, (key, value) => /token|secret|password|api[_-]?key/i.test(key) ? "[REDACTED]" : typeof value === "string" ? redact(value) : value));
}

registerTool({
  name: "ashlr__fleet_session",
  description: "Read a fleet job's latest metadata and metrics, PR URL, worktree and last 150 log lines from ~/.ashlr/fleet/jobs.jsonl and logs/<job_id>.log. Token-like strings are redacted; missing or unsafe files are reported. Read-only; accepts a job ID, never a path.",
  inputSchema: { type: "object", properties: { job_id: { type: "string", pattern: JOB_ID.source, maxLength: 128 } }, required: ["job_id"], additionalProperties: false },
  handler: async (args) => {
    if (Object.keys(args).some(key => key !== "job_id") || typeof args.job_id !== "string" || !JOB_ID.test(args.job_id)) {
      return { isError: true, content: [{ type: "text", text: "fleet_session requires a valid job_id and no other arguments" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(fleetSession(args.job_id)) }] };
  },
});
