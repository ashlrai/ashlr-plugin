/** Shared helpers for the fleet-*.ts scripts: default roots, strict
 * "--flag value" parsing, the writable-journal guard, the job-log lane
 * decode, bounded link-resistant file reads and the CLI result tail. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** Single bound for every bounded fleet file read (4 MiB). */
export const FLEET_MAX_BYTES = 4 * 1024 * 1024;

/** ~/.ashlr — the fleet family's data root. Functions, not constants, so a
 * HOME fixed after import (tests, spawned CLIs) still wins. */
export const defaultAshlrRoot = () => join(homedir(), ".ashlr");
/** ~/.ashlr/fleet — the fleet state/journal root. */
export const defaultFleetRoot = () => join(defaultAshlrRoot(), "fleet");
/** ~/.ashlr-runs — the router queue root the fleet reads. */
export const defaultRunsRoot = () => join(homedir(), ".ashlr-runs");

/** Plain-object view of a parsed value; anything else reads as {}. */
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A job row's lane: the pool/lane aliases, else the unassigned bucket. */
export const jobLane = (job: Record<string, unknown>): string =>
  String(job.pool ?? job.lane ?? "unassigned");

/** jobs.jsonl decode shared by the steering views: last row per id wins. */
export function jobLanes(text: string): Map<string, string> {
  const lanes = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const job = asRecord(JSON.parse(line));
    const id = job.job_id ?? job.id;
    if (id === undefined) continue;
    lanes.set(String(id), jobLane(job));
  }
  return lanes;
}

/** Strict "--flag value" pairs: flags must be allowlisted, each used at most
 * once, every value present and non-blank. Anything else throws `usage`. */
export function parseFlagPairs(args: string[], allowed: readonly string[], usage: string): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (key === undefined || !allowed.includes(key) || value === undefined || !value.trim() || options.has(key)) {
      throw new Error(usage);
    }
    options.set(key, value);
  }
  return options;
}

/** Resolve an --output option under root; only the fixed journal basename is
 * writable, including when callers supply a path — anything else throws
 * the caller's protection message. */
export function writableJournal(root: string, name: string, option: string | undefined, message: string): string {
  const output = resolve(root, option ?? name);
  if (basename(output).toUpperCase() !== name.toUpperCase() || output !== resolve(root, name)) throw new Error(message);
  return output;
}

export interface SafeFleetPath {
  /** Joined path under root naming a plain, singly-linked file. */
  path: string;
  /** lstat of the final component, for the open-time identity recheck. */
  stat: Stats;
}

/** Resolve a root-relative name without following links: no absolute paths,
 * traversal, separators or control bytes; root and every parent must be a
 * real directory; the leaf must be a regular file with no link aliases. */
export function safeFleetPath(root: string, name: string): SafeFleetPath {
  const parts = name.split("/");
  if (!name || isAbsolute(name) || /[\\:\x00-\x1f]/.test(name) ||
      parts.some(part => !part || part === "." || part === "..")) throw new Error("unsafe");
  let dir = resolve(root);
  if (!lstatSync(dir).isDirectory()) throw new Error("unsafe");
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    if (!lstatSync(dir).isDirectory()) throw new Error("unsafe");
  }
  const path = join(dir, parts[parts.length - 1]!);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe");
  return { path, stat };
}

/** Bounded read of a path already vetted by lstat (`entry`): opens without
 * following links, re-verifies identity (ino/dev) and caps the bytes.
 * Throws "unsafe" or "too_large"; raw fs errors pass through. */
export function readBoundedFile(path: string, entry: Stats, maxBytes = FLEET_MAX_BYTES): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new Error("unsafe");
    if (stat.size > maxBytes) throw new Error("too_large");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > maxBytes) throw new Error("too_large");
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/** Bounded, link-resistant read of a root-relative file. */
export function readFleetBuffer(root: string, name: string, maxBytes = FLEET_MAX_BYTES): Buffer {
  const { path, stat: entry } = safeFleetPath(root, name);
  return readBoundedFile(path, entry, maxBytes);
}

export const readFleetText = (root: string, name: string, maxBytes = FLEET_MAX_BYTES): string =>
  readFleetBuffer(root, name, maxBytes).toString("utf8");

/** CLI tail shared by the fleet-*.ts entry points: `run` prints its result as
 * one JSON line on stdout; on failure `error` (a string verbatim, a record as
 * JSON, or a formatter over the thrown value) goes to stderr with a nonzero
 * exit. The result is returned so callers can still adjust the exit code. */
export async function fleetCli<T>(run: () => T | Promise<T>,
  error: string | Record<string, unknown> | ((failure: unknown) => string | Record<string, unknown>),
): Promise<T | undefined> {
  try {
    const result = await run();
    console.log(JSON.stringify(result));
    return result;
  } catch (failure) {
    const message = typeof error === "function" ? error(failure) : error;
    console.error(typeof message === "string" ? message : JSON.stringify(message));
    process.exitCode = 1;
    return undefined;
  }
}
