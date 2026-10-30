/** Read-only fleet state with bounded, link-resistant file reads. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fleetSource, readBoundedText, readRunsText, runsRootFor } from "./_fleet-source";
import { registerTool } from "./_tool-base";

const FILES = ["targets.json", "holds.json", "jobs.jsonl", "leader-events.jsonl"] as const;

/** Bounded read of a fixed fleet-relative file; never follows links. */
export function readFleetText(root: string, name: string): string {
  if (!(FILES as readonly string[]).includes(name) && !/^logs\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.log$/.test(name)) throw new Error("unsafe");
  return readBoundedText(root, name);
}

/** Full job log: the fleet jobs.jsonl, else the router's metrics/jobs.jsonl. */
export function readFleetJobsText(root: string, runsRoot = runsRootFor(root)): string {
  try {
    return readFleetText(root, "jobs.jsonl");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readRunsText(runsRoot, "metrics/jobs.jsonl");
  }
}

/** Internal directory injection supports isolated fixtures; MCP accepts no paths.
 * When every fleet file is absent, state comes from the ~/.ashlr-runs router
 * queue (queue/slots.json, HOLD, metrics/jobs.jsonl, queue/dispatch-events.log). */
export function fleetState(root = join(homedir(), ".ashlr", "fleet"), runsRoot = runsRootFor(root)) {
  const errors: Record<string, string> = {};
  function read(name: typeof FILES[number]): unknown {
    try {
      const text = readFleetText(root, name);
      if (name.endsWith(".jsonl")) {
        return text.split("\n").filter(line => line.trim()).map(line => {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
          return value;
        });
      }
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object") throw new Error("invalid");
      return value;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      errors[name] = code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" :
        error instanceof Error && ["unsafe", "too_large", "invalid"].includes(error.message) ? error.message : "unavailable";
      return null;
    }
  }
  const [targets, holds, jobs, events] = FILES.map(read);
  // The old layout wins whenever any fleet file exists; a fully absent fleet
  // falls back to the router queue so the workbench sees live state.
  if (FILES.every(name => errors[name] === "missing")) return fleetSource(runsRoot);
  return {
    targets, holds,
    jobs: Array.isArray(jobs) ? jobs.slice(-20) : null,
    leader_event: Array.isArray(events) ? events.at(-1) ?? null : null,
    errors,
  };
}

registerTool({
  name: "ashlr__fleet_state",
  description: "Read fleet lane targets and holds, the last 20 job states and latest leader event from ~/.ashlr/fleet/{targets.json,holds.json,jobs.jsonl,leader-events.jsonl}; when every fleet file is absent, the equivalent state comes from ~/.ashlr-runs/{queue/slots.json,HOLD,metrics/jobs.jsonl,queue/dispatch-events.log}. Read-only; missing or invalid files are reported as unavailable. Never opens environment or secret files.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (args) => {
    if (Object.keys(args).length) return { isError: true, content: [{ type: "text", text: "fleet_state accepts no arguments" }] };
    return { content: [{ type: "text", text: JSON.stringify(fleetState()) }] };
  },
});
