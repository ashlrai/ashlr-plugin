/** Read-only event feed; cursors track physical lines independently per source. */
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, parse, relative, sep } from "node:path";
import { registerTool } from "./_tool-base";

const FILES = ["dispatch-events.log", "metrics/jobs.jsonl"] as const;
const MAX_BYTES = 4 * 1024 * 1024;
export interface FleetEvent {
  source: typeof FILES[number];
  line: number;
  type: string;
  timestamp: string | null;
  job_id: string | null;
}
function positions(cursor?: string): number[] {
  if (cursor === undefined) return [0, 0];
  if (!/^v1:\d+:\d+$/.test(cursor)) throw new Error("invalid cursor");
  const values = cursor.slice(3).split(":").map(Number);
  if (values.some(n => !Number.isSafeInteger(n))) throw new Error("invalid cursor");
  return values;
}
function read(root: string, name: typeof FILES[number]): string {
  let fd: number | undefined;
  try {
    const path = resolve(root, name);
    let parent = parse(path).root;
    for (const part of relative(parent, path).split(sep).slice(0, -1)) {
      parent = join(parent, part);
      if (!lstatSync(parent).isDirectory()) throw new Error("unsafe");
    }
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error("unsafe");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new Error("unsafe");
    if (stat.size > MAX_BYTES) throw new Error("too_large");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_BYTES) throw new Error("too_large");
    return buffer.toString("utf8", 0, length);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function event(line: string, source: FleetEvent["source"], number: number): FleetEvent {
  let value: Record<string, unknown>;
  if (source === "dispatch-events.log" && !line.trimStart().startsWith("{")) {
    const match = line.match(/^\[?(\d{4}-\d\d-\d\dT[^\s\]]+)\]?\s+([\w.-]+)(?:\s+.*)?$/);
    if (!match) throw new Error("invalid");
    value = { timestamp: match[1], type: match[2], job_id: line.match(/\bjob(?:_id)?=([\w.-]+)/)?.[1] };
  } else {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    value = parsed as Record<string, unknown>;
  }
  const string = (...keys: string[]) => keys.map(key => value[key]).find(v => typeof v === "string" && v.length) as string | undefined;
  const type = string("type", "event", "state", "status");
  if (!type) throw new Error("invalid");
  return { source, line: number, type, timestamp: string("timestamp", "ts", "time") ?? null, job_id: string("job_id", "job", "id") ?? null };
}
/** Fixed ~/.ashlr layout in production; root injection is only for fixtures. */
export function fleetEvents(args: { cursor?: string; limit?: number } = {}, root = join(homedir(), ".ashlr")) {
  const offsets = positions(args.cursor), limit = args.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer from 1 to 200");
  const events: FleetEvent[] = [], errors: Record<string, string> = {};
  let more = false;
  FILES.forEach((source, index) => {
    try {
      // Ignore an incomplete final line: writers may be mid-append.
      const text = read(root, source), lines = text.split("\n").slice(0, -1);
      if (offsets[index]! > lines.length) throw new Error("stale_cursor");
      while (offsets[index]! < lines.length) {
        if (events.length === limit) { more = true; break; }
        const number = ++offsets[index]!;
        if (!lines[number - 1]!.trim()) continue;
        try { events.push(event(lines[number - 1]!, source, number)); }
        catch { errors[source] = "invalid"; }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      errors[source] = code === "ENOENT" ? "missing" : error instanceof Error && ["unsafe", "too_large", "stale_cursor"].includes(error.message) ? error.message : "unavailable";
    }
  });
  return { events, cursor: `v1:${offsets.join(":")}`, has_more: more, errors };
}
registerTool({
  name: "ashlr__fleet_events",
  description: "Read typed events from ~/.ashlr/dispatch-events.log and ~/.ashlr/metrics/jobs.jsonl. JSON records or timestamped dispatch text; complete lines only, dispatch source first. Opaque per-source cursor supports polling; limit defaults to 200 (maximum 200). Missing, unsafe and malformed files are reported without raw contents. Read-only.",
  inputSchema: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200, default: 200 } }, additionalProperties: false },
  handler: async args => {
    try {
      if (Object.keys(args).some(k => !["cursor", "limit"].includes(k)) || (args.cursor !== undefined && typeof args.cursor !== "string") || (args.limit !== undefined && typeof args.limit !== "number")) throw new Error("invalid arguments");
      return { content: [{ type: "text", text: JSON.stringify(fleetEvents(args)) }] };
    } catch { return { isError: true, content: [{ type: "text", text: "Expected an optional fleet events cursor and integer limit from 1 to 200" }] }; }
  },
});
