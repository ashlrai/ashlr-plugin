/** Read-only fleet diagnostics; scripts retain ownership of report semantics. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fleetGhosts, type GhostDeps } from "../scripts/fleet-ghosts";
import { fleetDirtyTriage } from "../scripts/fleet-dirty-triage";
import { registerTool, type ToolResult } from "./_tool-base";

const INVALID = "invalid fleet health arguments";
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
function argumentsOf(args: unknown, keys: string[]): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) throw new Error(INVALID);
  return args as Record<string, unknown>;
}

/** Root/dependency injection is internal only; MCP callers cannot select paths. */
export function fleetGhostsCall(args: unknown, root = join(homedir(), ".ashlr", "fleet", "runs"), deps?: GhostDeps) {
  return result(() => {
    argumentsOf(args, []);
    return fleetGhosts(root, deps);
  }, "fleet ghosts unavailable");
}

export async function fleetDirtyTriageCall(args: unknown, deps?: Parameters<typeof fleetDirtyTriage>[1]) {
  return result(() => {
    const value = argumentsOf(args, ["repos", "staleDays"]), argv: string[] = [];
    if (Object.hasOwn(value, "repos")) {
      const repos = value.repos;
      if (!Array.isArray(repos) || repos.length > 20 || new Set(repos).size !== repos.length || repos.some(repo => typeof repo !== "string" || !REPO.test(repo))) throw new Error(INVALID);
      for (const repo of repos) argv.push("--repo", repo);
    }
    if (Object.hasOwn(value, "staleDays")) {
      if (!Number.isInteger(value.staleDays) || (value.staleDays as number) < 1 || (value.staleDays as number) > 365) throw new Error(INVALID);
      argv.push("--stale-days", String(value.staleDays));
    }
    return fleetDirtyTriage(argv, deps);
  }, "fleet dirty triage unavailable; requires a pinned Locus identity");
}

async function result(run: () => unknown, unavailable: string): Promise<ToolResult> {
  try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
  catch (error) {
    // Locus/gh errors can contain credentials; never serialize command errors.
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error && error.message === INVALID ? INVALID : unavailable }) }] };
  }
}

registerTool({
  name: "ashlr__fleet_ghosts",
  description: "Read ghost slots, stalled jobs and reported versus live job counts by lane from ~/.ashlr/fleet/runs. Read-only JSON; unknown process liveness remains explicit. Accepts no arguments or paths; missing sources return an error.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async args => fleetGhostsCall(args),
});

registerTool({
  name: "ashlr__fleet_dirty_triage",
  description: "Read the DIRTY PR backlog, ranked as recut-worthy, superseded or stale with C1-C6 reasons and counts. Optional repos (up to 20 owner/name values) defaults to the current repository; staleDays defaults to 14. Read-only GitHub queries through a pinned Locus identity; never changes PRs or branches. Returns JSON including partial errors and truncation.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      repos: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", pattern: REPO.source } },
      staleDays: { type: "integer", minimum: 1, maximum: 365, default: 14 },
    },
  },
  handler: async args => fleetDirtyTriageCall(args),
});
