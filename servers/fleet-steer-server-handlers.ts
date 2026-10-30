/** The human steering CLI is authoritative; MCP can only append proposals. */
import { fleetSteer } from "../scripts/fleet-steer";
import { registerTool, type ToolHandler } from "./_tool-base";

type Command = "lanes" | "proposals" | "propose";
const identifier = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" };
const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const proposeSchema = {
  ...emptySchema,
  properties: {
    action: { type: "string", enum: ["reassign", "set-slots"] }, lane: identifier, job_id: identifier,
    slots: { type: "integer", minimum: 0, maximum: 1024 },
    author: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    reason: { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" },
  },
  required: ["action", "lane", "author", "reason"],
  oneOf: [
    { properties: { action: { const: "reassign" } }, required: ["job_id"], not: { required: ["slots"] } },
    { properties: { action: { const: "set-slots" } }, required: ["slots"], not: { required: ["job_id"] } },
  ],
};

function handler(command: Command): ToolHandler["handler"] {
  return async args => {
    try {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid fleet steer arguments");
      const fields = command !== "propose" ? [] :
        ["action", "lane", "author", "reason", ...(args.action === "reassign" ? ["job_id"] : ["slots"])];
      if (Object.keys(args).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(args, key))) {
        throw new Error("invalid fleet steer fields");
      }
      const argv: string[] = [command];
      for (const field of fields) {
        const value = args[field];
        // Do not coerce JSON objects, booleans or numeric strings into CLI inputs.
        if (field === "slots" ? typeof value !== "number" || !Number.isSafeInteger(value) : typeof value !== "string") {
          throw new Error(`invalid fleet steer ${field}`);
        }
        argv.push(`--${field.replace("_", "-")}`, String(value));
      }
      return { content: [{ type: "text", text: JSON.stringify(fleetSteer(argv)) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safe = message.startsWith("invalid fleet steer") || message === "duplicate proposal" ? message :
        message.startsWith("Usage: fleet-steer") ? "invalid fleet steer arguments" : "fleet steer unavailable";
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: safe }) }] };
    }
  };
}

registerTool({
  name: "ashlr__fleet_lanes",
  description: "Read fleet lane targets, holds, job counts and source errors as JSON using fleet-steer lanes. Read-only; fixed ~/.ashlr/fleet root, no arguments or paths.",
  inputSchema: emptySchema, handler: handler("lanes"),
});
registerTool({
  name: "ashlr__fleet_proposals",
  description: "Read the fleet steering proposal journal and skipped-record count as JSON using fleet-steer proposals. Read-only; fixed ~/.ashlr/fleet/steer-proposals.jsonl, no arguments or paths.",
  inputSchema: emptySchema, handler: handler("proposals"),
});
registerTool({
  name: "ashlr__fleet_propose",
  description: "Propose fleet reassign (job_id, lane) or set-slots (lane, slots 0–1024) using fleet-steer. Requires author (caller attribution) and reason. Returns JSON; refuses duplicate pending proposals. Only appends ~/.ashlr/fleet/steer-proposals.jsonl for controller review; never applies changes. No caller-selected paths.",
  inputSchema: proposeSchema, handler: handler("propose"),
});
