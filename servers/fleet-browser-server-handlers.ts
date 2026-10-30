/** Read-only fleet browser view; the job names a fixed artifact directory, never a path. */
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fleetBrowserView } from "../scripts/fleet-browser-view";
import { registerTool } from "./_tool-base";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Root injection is internal only; MCP callers pass a job id, never paths. */
export function fleetBrowserCall(args: unknown, root = join(homedir(), ".ashlr")) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid fleet browser arguments");
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some(key => !["job", "cursor", "limit"].includes(key))) throw new Error("invalid fleet browser arguments");
  const { job, cursor, limit } = value;
  if (typeof job !== "string" || !JOB_ID.test(job)) throw new Error("invalid fleet browser job");
  if (cursor !== undefined && typeof cursor !== "string") throw new Error("invalid fleet browser cursor");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit))) throw new Error("invalid fleet browser limit");
  // Same checks as GET /api/browser: the job id names a fixed artifact directory;
  // every component must be a real directory, so linked parents are refused.
  let dir = root;
  for (const part of ["fleet", "browser", job]) {
    dir = join(dir, part);
    try {
      if (!lstatSync(dir).isDirectory()) throw new Error("browser view unavailable");
    } catch { throw new Error("browser view unavailable"); }
  }
  return fleetBrowserView(dir, { cursor, limit });
}

registerTool({
  name: "ashlr__fleet_browser",
  description: "Read a fleet job's browser frames from ~/.ashlr/fleet/browser/<job>: paged frame paths, the latest frame, current URL and an opaque cursor for polling. job is a job id (validated like the /api/browser route), never a path; limit defaults to 100 (maximum 200). Read-only.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      job: { type: "string", pattern: JOB_ID.source, maxLength: 128 },
      cursor: { type: "string", maxLength: 512 },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
    required: ["job"],
  },
  handler: async args => {
    try { return { content: [{ type: "text", text: JSON.stringify(fleetBrowserCall(args)) }] }; }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const text = ["invalid fleet browser", "invalid limit", "invalid or stale cursor", "browser view unavailable"].some(prefix => message.startsWith(prefix))
        ? message : "fleet browser view unavailable";
      return { isError: true, content: [{ type: "text", text }] };
    }
  },
});
