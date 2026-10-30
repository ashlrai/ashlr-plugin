/** Read-only fleet resource ledger; scripts retain ownership of ledger semantics. */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureFleetResources } from "../scripts/fleet-resources";
import { registerTool, type ToolResult } from "./_tool-base";

const INVALID = "invalid fleet resources arguments";

/** Runs/clock/monitor injection is internal only; MCP callers cannot select paths. */
export function fleetResourcesCall(
  args: unknown,
  runs = join(homedir(), ".ashlr-runs"),
  now = Date.now(),
  monitor?: () => string,
): ToolResult {
  try {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0) throw new Error(INVALID);
    const { ledger, refreshed } = ensureFleetResources(runs, 6, now, monitor);
    return { content: [{ type: "text", text: JSON.stringify({ ...ledger, refreshed }) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error && error.message === INVALID ? INVALID : "fleet resources unavailable" }) }] };
  }
}

registerTool({
  name: "ashlr__fleet_resources",
  description: "Read the shared fleet resource ledger at ~/.ashlr-runs/resources.json: per-lane availability, cap headroom, slot targets versus running jobs, jobs and tokens per hour and projected exhaustion, plus per-source status. Regenerates the ledger via `ashlr resources --json` when resources.json is missing or over 60 seconds old; fresher ledgers serve from disk without re-running. Read-only; accepts no arguments or paths.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async args => fleetResourcesCall(args),
});
