/** Read-only fleet snapshot. Only the four named state files are ever opened. */
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, relative, sep } from "node:path";
import { registerTool } from "./_tool-base";

const FILES = ["targets.json", "holds.json", "jobs.jsonl", "leader-events.jsonl"] as const;
const MAX_BYTES = 4 * 1024 * 1024;

/** Internal directory injection supports isolated fixtures; MCP accepts no paths. */
export function fleetState(root = join(homedir(), ".ashlr", "fleet")) {
  const errors: Record<string, string> = {};
  function read(name: typeof FILES[number]): unknown {
    let fd: number | undefined;
    try {
      // Reject symlinks in every parent as well as the file itself.
      const absolute = resolve(root);
      let parent = parse(absolute).root;
      for (const part of relative(parent, absolute).split(sep).filter(Boolean)) {
        parent = join(parent, part);
        if (!lstatSync(parent).isDirectory()) throw new Error("unsafe");
      }
      const path = join(absolute, name);
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.nlink !== 1) throw new Error("unsafe");
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new Error("unsafe");
      if (stat.size > MAX_BYTES) throw new Error("too_large");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_BYTES) throw new Error("too_large");
      const text = buffer.toString("utf8", 0, length);
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
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const [targets, holds, jobs, events] = FILES.map(read);
  return {
    targets, holds,
    jobs: Array.isArray(jobs) ? jobs.slice(-20) : null,
    leader_event: Array.isArray(events) ? events.at(-1) ?? null : null,
    errors,
  };
}

registerTool({
  name: "ashlr__fleet_state",
  description: "Read fleet lane targets and holds, the last 20 job states and latest leader event from ~/.ashlr/fleet/{targets.json,holds.json,jobs.jsonl,leader-events.jsonl}. Read-only; missing or invalid files are reported as unavailable. Never opens environment or secret files.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (args) => {
    if (Object.keys(args).length) return { isError: true, content: [{ type: "text", text: "fleet_state accepts no arguments" }] };
    return { content: [{ type: "text", text: JSON.stringify(fleetState()) }] };
  },
});
