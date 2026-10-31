/** Read-only adapter: the ~/.ashlr-runs router queue mapped to the fleet state shape. */
import { constants, fstatSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fleetLive } from "./_fleet-live";
import type { GhostDeps } from "../scripts/fleet-ghosts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REASON = 500;
export const RUNS_FILES = ["queue/slots.json", "HOLD", "metrics/jobs.jsonl", "queue/dispatch-events.log"] as const;

/** ~/.ashlr/fleet and ~/.ashlr-runs are siblings; injected fixture roots map alike. */
export const runsRootFor = (fleetRoot: string): string =>
  join(dirname(dirname(resolve(fleetRoot))), ".ashlr-runs");

/** Bounded read of a root-relative file; rejects links, special files and traversal. */
export function readBoundedBuffer(root: string, name: string): Buffer {
  if (isAbsolute(name) || name.split(/[\\/]+/).includes("..")) throw new Error("unsafe");
  let fd: number | undefined;
  try {
    // Reject symlinks in every parent as well as the file itself.
    const absolute = resolve(root);
    let parent = parse(absolute).root;
    for (const part of relative(parent, resolve(absolute, name, "..")).split(sep).filter(Boolean)) {
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
    return buffer.subarray(0, length);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readBoundedText(root: string, name: string): string {
  return readBoundedBuffer(root, name).toString("utf8");
}

/** Bounded read of a fixed runs-relative source; never follows links. */
export function readRunsText(root: string, name: string): string {
  if (!(RUNS_FILES as readonly string[]).includes(name)) throw new Error("unsafe");
  return readBoundedText(root, name);
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const failure = (error: unknown): string =>
  code(error) === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" :
    error instanceof Error && ["unsafe", "too_large", "invalid"].includes(error.message) ? error.message : "unavailable";

/** HOLD is a queue sentinel, not a record: its presence alone signals a fleet hold.
 * A JSON object carries per-lane reasons verbatim, a JSON string list holds those
 * lanes, and any other content is the reason applied to every lane in slots.json
 * ("*" when lanes are unknown). An absent file means no hold — never an error. */
function holdsFrom(text: string, lanes: string[]): Record<string, unknown> {
  const trimmed = text.trim();
  let reason = (trimmed.split("\n")[0] ?? "").trim() || "held";
  try {
    const value: unknown = JSON.parse(trimmed || "null");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (Array.isArray(value)) {
      return Object.fromEntries(value.filter((lane): lane is string => typeof lane === "string").map(lane => [lane, "held"]));
    }
    if (typeof value === "string" && value.trim()) reason = value.trim();
  } catch { /* Plain text is already the reason. */ }
  return Object.fromEntries((lanes.length ? lanes : ["*"]).map(lane => [lane, reason.slice(0, MAX_REASON)]));
}

/** A dispatch line is a JSON record or "[timestamp] type key=value" router text. */
function dispatchEvent(line: string): Record<string, unknown> | null {
  if (!line.trimStart().startsWith("{")) {
    const match = line.match(/^\[?(\d{4}-\d\d-\d\dT[^\s\]]+)\]?\s+([\w.-]+)(?:\s+.*)?$/);
    if (!match) return null;
    return { timestamp: match[1], type: match[2], job_id: line.match(/\bjob(?:_id)?=([\w.-]+)/)?.[1] ?? null };
  }
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** The fleetState shape read from ~/.ashlr-runs; errors keep the canonical fleet keys. */
export function fleetSource(root = join(homedir(), ".ashlr-runs"), deps: GhostDeps = {}) {
  const errors: Record<string, string> = {};
  const read = (name: typeof RUNS_FILES[number], key: string): string | null => {
    try { return readRunsText(root, name); }
    catch (error) { errors[key] = failure(error); return null; }
  };
  const slotsText = read("queue/slots.json", "targets.json");
  const jobsText = read("metrics/jobs.jsonl", "jobs.jsonl");
  const dispatchText = read("queue/dispatch-events.log", "leader-events.jsonl");

  let targets: unknown = null;
  if (slotsText !== null) {
    try {
      targets = JSON.parse(slotsText);
      if (!targets || typeof targets !== "object") throw new Error("invalid");
    } catch (error) { targets = null; errors["targets.json"] = failure(error); }
  }
  const lanes = targets && typeof targets === "object" && !Array.isArray(targets)
    ? Object.keys(targets as Record<string, unknown>) : [];

  let holds: Record<string, unknown> | null;
  try {
    holds = holdsFrom(readRunsText(root, "HOLD"), lanes);
  } catch (error) {
    if (code(error) === "ENOENT") {
      // The sentinel is absent: report an empty hold set only when the queue tree
      // itself is present; a missing tree stays unknown like every other source.
      try { holds = lstatSync(resolve(root)).isDirectory() ? {} : (errors["holds.json"] = "missing", null); }
      catch { holds = null; errors["holds.json"] = "missing"; }
    } else {
      // A present but unreadable sentinel fails closed: assume the fleet is held.
      errors["holds.json"] = failure(error);
      holds = Object.fromEntries((lanes.length ? lanes : ["*"]).map(lane => [lane, "held"]));
    }
  }

  let jobs: Record<string, unknown>[] | null = null;
  if (jobsText !== null) {
    const rows: Record<string, unknown>[] = [];
    for (const line of jobsText.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
        rows.push(value as Record<string, unknown>);
      } catch (error) { errors["jobs.jsonl"] = failure(error); }
    }
    jobs = errors["jobs.jsonl"] ? null : rows.slice(-20);
  }

  // A log tolerates bad lines: the last parseable event still leads the fleet.
  let leader_event: unknown = null;
  if (dispatchText !== null) {
    for (const line of dispatchText.split("\n")) {
      if (!line.trim()) continue;
      const event = dispatchEvent(line);
      if (event === null) errors["leader-events.jsonl"] = "invalid";
      else leader_event = event;
    }
  }

  // queue/run/ splits recorded jobs into live, ghost and held by process
  // checks and phdrip hold markers; its detail errors stay nested in live.
  const live = fleetLive(root, deps);
  const liveError = Object.values(live.errors)[0];
  if (liveError !== undefined)
    errors["live.json"] = ["ENOENT", "ENOTDIR"].includes(liveError) ? "missing" : "unavailable";

  return { targets, holds, jobs, leader_event, live, errors };
}
