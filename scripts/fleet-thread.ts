#!/usr/bin/env bun
/** bun scripts/fleet-thread.ts JOB_ID
 * Prints a JSON array from ~/.ashlr-runs/{metrics/jobs.jsonl,queue/dispatch-events.log}.
 * Oldest first; ties retain dispatch-before-metrics, then physical line order.
 * Missing/invalid timestamps become null and sort last. Unknown jobs return [].
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SOURCES = ["queue/dispatch-events.log", "metrics/jobs.jsonl"] as const;
const MAX_BYTES = 4 * 1024 * 1024;
// Lines arrive trimmed and split on "\n", so \s[\s\S]* is the same tail as \s+.* without the ambiguous split.
export const DISPATCH_LINE = /^\[?(\d{4}-\d\d-\d\dT[^\s\]]+)\]?\s+([\w.-]+)(?:\s[\s\S]*)?$/;
function validateId(jobId: string): void {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error("Invalid job ID");
}

/** Pure snapshot parser; accepts complete JSON at EOF even without a newline.
 * Mirrors fleet-events aliases without importing its MCP registration side effect.
 * Only event metadata is returned, never arbitrary fields or raw dispatch text.
 */
export function fleetThread(jobId: string, jobsText: string, dispatchText: string) {
  validateId(jobId);
  const timeline: { source: typeof SOURCES[number]; line: number; type: string; timestamp: string | null; job_id: string }[] = [];
  for (const [index, text] of [dispatchText, jobsText].entries()) {
    text.split("\n").forEach((line, number) => {
      line = line.trim();
      if (!line) return;
      try {
        let row: unknown;
        if (index === 0 && !line.startsWith("{")) {
          const match = line.match(DISPATCH_LINE);
          if (!match) return;
          row = { timestamp: match[1], type: match[2], job_id: line.match(/(?:^|\s)job(?:_id)?=([^\s]+)/)?.[1] };
        } else row = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row)) return;
        const value = row as Record<string, unknown>;
        const string = (...keys: string[]) => keys.map(key => value[key]).find(v => typeof v === "string" && v.length) as string | undefined;
        if (string("job_id", "job", "id") !== jobId) return;
        const type = string("type", "event", "state", "status");
        if (!type) return;
        const time = Date.parse(string("timestamp", "ts", "time") ?? "");
        timeline.push({ source: SOURCES[index]!, line: number + 1, type,
          timestamp: Number.isFinite(time) ? new Date(time).toISOString() : null, job_id: jobId });
      } catch { /* A malformed or partially appended line cannot hide later events. */ }
    });
  }
  const time = (event: typeof timeline[number]) => event.timestamp === null ? Infinity : Date.parse(event.timestamp);
  return timeline.sort((a, b) => time(a) - time(b));
}

/** Fixed, bounded sources only. Reject links and special files before reading. */
function readSource(source: typeof SOURCES[number]): string {
  const root = join(homedir(), ".ashlr-runs"), path = join(root, source);
  if (!lstatSync(root).isDirectory() || !lstatSync(dirname(path)).isDirectory()) throw new Error("Unsafe source");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Unsafe or oversized source");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_BYTES) throw new Error("Oversized source");
    return buffer.toString("utf8", 0, length);
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error("Expected one job ID");
    validateId(args[0]!);
    console.log(JSON.stringify(fleetThread(args[0]!, readSource(SOURCES[1]), readSource(SOURCES[0]))));
  } catch {
    console.error("fleet-thread: invalid arguments or unavailable/unsafe log files. Usage: bun scripts/fleet-thread.ts JOB_ID");
    process.exitCode = 1;
  }
}
