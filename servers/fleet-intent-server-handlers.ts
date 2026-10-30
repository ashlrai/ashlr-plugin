/** Record fleet requests for controller review; never execute them. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { registerTool } from "./_tool-base";

const fields: Record<string, string[]> = {
  pause: ["lane"], resume: ["lane"], kill: ["job_id"],
  reassign: ["job_id", "lane"], "set-slot": ["lane", "slots"],
};
const identifier = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" };
const text = { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" };
const inputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: Object.keys(fields) }, lane: identifier, job_id: identifier,
    slots: { type: "integer", minimum: 0, maximum: 1024 }, requested_by: text, reason: text,
  },
  required: ["action", "requested_by", "reason"], additionalProperties: false,
  oneOf: Object.entries(fields).map(([action, required]) => ({
    properties: { action: { const: action } }, required,
    not: { anyOf: ["lane", "job_id", "slots"].filter(key => !required.includes(key)).map(key => ({ required: [key] })) },
  })),
};

/** Internal root injection is for fixtures only; callers cannot choose paths. */
export function fleetIntent(args: unknown, root = join(homedir(), ".ashlr", "fleet")) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid fleet intent");
  const value = args as Record<string, unknown>;
  const action = value.action;
  if (typeof action !== "string" || !Object.hasOwn(fields, action)) throw new Error("invalid fleet action");
  const required = ["action", "requested_by", "reason", ...fields[action]!];
  if (Object.keys(value).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error("invalid fleet intent fields");
  }
  for (const key of required.filter(key => key !== "action")) {
    const item = value[key];
    const valid = key === "slots" ? Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 1024 :
      typeof item === "string" && (key === "lane" || key === "job_id" ?
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item) : item.length <= 512 && /\S/.test(item));
    if (!valid) throw new Error(`invalid fleet intent ${key}`);
  }
  const intent = { ...value, id: randomUUID(), requested_at: new Date().toISOString(), status: "pending" };
  const absolute = resolve(root);
  let parent = parse(absolute).root;
  // Reject symlink parents before creating or opening anything beneath them.
  for (const part of relative(parent, absolute).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("fleet intent log unavailable");
    }
    if (!lstatSync(parent).isDirectory()) throw new Error("unsafe fleet intent directory");
  }
  let fd: number | undefined;
  try {
    fd = openSync(join(absolute, "intents.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe fleet intent log");
    const line = Buffer.from(JSON.stringify(intent) + "\n");
    if (writeSync(fd, line) !== line.length) throw new Error("incomplete fleet intent append");
    fsyncSync(fd);
  } catch {
    throw new Error("fleet intent log unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return intent;
}

registerTool({
  name: "ashlr__fleet_intent",
  description: "Append an audited pending request to ~/.ashlr/fleet/intents.jsonl; never execute it. pause/resume require lane; kill requires job_id; reassign requires job_id and lane; set-slot requires lane and slots (0–1024). All requests require requested_by (caller-supplied attribution) and reason. No other fields or paths accepted.",
  inputSchema,
  handler: async args => {
    try { return { content: [{ type: "text", text: JSON.stringify(fleetIntent(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error && error.message.startsWith("invalid fleet") ? error.message : "fleet intent log unavailable" }] }; }
  },
});
