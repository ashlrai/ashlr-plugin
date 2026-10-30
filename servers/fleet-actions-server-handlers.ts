/** Agent control requests; the fleet controller owns execution. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFleetRecord } from "./fleet-intent-server-handlers";
import { registerTool } from "./_tool-base";

const fields: Record<string, string[]> = {
  pause: ["lane"], resume: ["lane"], kill: ["job_id"],
  reassign: ["job_id", "lane"], slots: ["lane", "slots"], steer: ["job_id", "message"],
};
const identifier = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" };
const text = { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" };
const inputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: Object.keys(fields) }, lane: identifier, job_id: identifier,
    slots: { type: "integer", minimum: 0, maximum: 1024 }, message: text,
    requested_by: text, reason: text, dry_run: { type: "boolean", default: true },
  },
  required: ["action", "requested_by", "reason"],
  oneOf: Object.entries(fields).map(([action, required]) => ({
    properties: { action: { const: action } }, required,
    not: { anyOf: ["lane", "job_id", "slots", "message"].filter(key => !required.includes(key)).map(key => ({ required: [key] })) },
  })),
};

/** Root injection is internal only. The append-only journal is also the controller request queue. */
export function fleetAct(args: unknown, root = join(homedir(), ".ashlr", "fleet")) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid fleet action");
  const value = args as Record<string, unknown>;
  if (typeof value.action !== "string" || !Object.hasOwn(fields, value.action)) throw new Error("invalid fleet action");
  const required = ["action", "requested_by", "reason", ...fields[value.action]!];
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, "dry_run"].includes(key))) throw new Error("invalid fleet action fields");
  if (Object.hasOwn(value, "dry_run") && typeof value.dry_run !== "boolean") throw new Error("invalid fleet action dry_run");
  for (const key of required.filter(key => key !== "action")) {
    const item = value[key];
    const valid = key === "slots" ? Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 1024 :
      typeof item === "string" && (key === "lane" || key === "job_id" ? new RegExp(identifier.pattern).test(item) : item.length <= 512 && /\S/.test(item));
    if (!valid) throw new Error(`invalid fleet action ${key}`);
  }
  const dry_run = value.dry_run !== false;
  const record = { ...value, dry_run, id: randomUUID(), requested_at: new Date().toISOString(), status: dry_run ? "dry_run" : "pending" };
  appendFleetRecord(root, "actions.jsonl", record);
  return record;
}

registerTool({
  name: "ashlr__fleet_act",
  description: "Request fleet pause/resume (lane), kill (job_id), reassign (job_id, lane), slots (lane, slots 0–1024), or steer (job_id, message). Requires requested_by (caller attribution) and reason. dry_run defaults true: audit preview only. false appends a pending controller request, never claims execution. All valid calls append to ~/.ashlr/fleet/actions.jsonl; controller execution is external. No caller-selected paths.",
  inputSchema,
  handler: async args => {
    try { return { content: [{ type: "text", text: JSON.stringify(fleetAct(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error && error.message.startsWith("invalid fleet action") ? error.message : "fleet action audit unavailable" }] }; }
  },
});
