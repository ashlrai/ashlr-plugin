/** Fleet snapshot deltas and governed direction surface; no caller-selected paths. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fleetDirection } from "../scripts/fleet-direction";
import { fleetSnapshot } from "../scripts/fleet-snapshot";
import { primaryProjectRoot } from "./_cwd-clamp";
import { registerTool } from "./_tool-base";

const snapshotSchema = {
  type: "object", additionalProperties: false,
  properties: { cursor: { type: "string", maxLength: 4 * 1024 * 1024 } },
};

/** Top-level project markdown only: blocks dotfiles, traversal and absolute paths. */
const DIRECTION_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.md$/;
const PROTECTED_MESSAGE = "Proposals may only append to DIRECTION-PROPOSED.md; MASON-INBOX.md and VISION.md are protected";
const MAX_PROPOSAL = 8192;
const author = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" };
const directionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    command: { type: "string", enum: ["read", "propose"] },
    direction: { type: "string", pattern: DIRECTION_FILE.source },
    author, text: { type: "string", minLength: 1, maxLength: MAX_PROPOSAL, pattern: "\\S" },
  },
  required: ["command"],
  oneOf: [
    { properties: { command: { const: "read" } }, not: { anyOf: [{ required: ["author"] }, { required: ["text"] }] } },
    { properties: { command: { const: "propose" } }, required: ["author", "text"], not: { required: ["direction"] } },
  ],
};

/** Root injection is internal only; MCP callers pass a cursor, never paths. */
export function fleetSnapshotCall(args: unknown, root = join(homedir(), ".ashlr", "fleet")) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid fleet snapshot arguments");
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "cursor")) throw new Error("invalid fleet snapshot arguments");
  if (value.cursor !== undefined && typeof value.cursor !== "string") throw new Error("invalid fleet snapshot cursor");
  return fleetSnapshot(value.cursor, root);
}

/** Root injection is internal only; production reads and appends stay under the launch project. */
export function fleetDirectionCall(args: unknown, root = primaryProjectRoot(), now = new Date()) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid fleet direction arguments");
  const value = args as Record<string, unknown>;
  const command = value.command;
  if (command !== "read" && command !== "propose") throw new Error("invalid fleet direction command");
  const allowed = command === "read" ? ["command", "direction"] : ["command", "author", "text"];
  const required = command === "read" ? [] : ["author", "text"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error("invalid fleet direction fields");
  }
  const argv = [command, "--root", root];
  if (command === "read") {
    const direction = value.direction;
    if (direction !== undefined) {
      // The proposal journal is not a direction source; refuse it case-insensitively too.
      if (typeof direction !== "string" || !DIRECTION_FILE.test(direction)) throw new Error("invalid fleet direction file");
      if (direction.toUpperCase() === "DIRECTION-PROPOSED.MD") throw new Error(PROTECTED_MESSAGE);
      argv.push("--direction", direction);
    }
  } else {
    const { author: name, text } = value;
    if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(name)) throw new Error("invalid fleet direction author");
    if (typeof text !== "string" || !text.trim() || text.length > MAX_PROPOSAL) throw new Error("invalid fleet direction text");
    argv.push("--author", name, "--text", text);
  }
  return fleetDirection(argv, now);
}

function errorText(error: unknown, prefixes: string[], fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return prefixes.some(prefix => message.startsWith(prefix)) ? message : fallback;
}

registerTool({
  name: "ashlr__fleet_snapshot",
  description:
    "Read fleet lanes, complete job upserts, PR links and latest leader event, with ~/.ashlr-runs fallback. Pass cursor for net changes and removed IDs. Reports source errors. Read-only; no paths.",
  inputSchema: snapshotSchema,
  handler: async args => {
    try { return { content: [{ type: "text", text: JSON.stringify(fleetSnapshotCall(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: errorText(error, ["invalid fleet snapshot", "invalid snapshot cursor"], "fleet snapshot unavailable") }] }; }
  },
});

registerTool({
  name: "ashlr__fleet_direction",
  description:
    "Read project direction (default VISION.md) or propose changes with author/text. Proposals append only to DIRECTION-PROPOSED.md; never adopt direction or write VISION.md or MASON-INBOX.md.",
  inputSchema: directionSchema,
  handler: async args => {
    try { return { content: [{ type: "text", text: JSON.stringify(fleetDirectionCall(args)) }] }; }
    catch (error) {
      const fallback = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "fleet direction source missing" : "fleet direction unavailable";
      return { isError: true, content: [{ type: "text", text: errorText(error, ["invalid fleet direction", PROTECTED_MESSAGE, "Usage: fleet-direction"], fallback) }] };
    }
  },
});
