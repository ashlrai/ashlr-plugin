#!/usr/bin/env bun
/** bun scripts/fleet-author.ts — read-only JSON; no arguments.
 * Fixed ~/.ashlr-runs inputs: router-events.log, queue-author-codex.log,
 * ROUTER-QUEUE.md. Ages are seconds; lines_from_tail is zero for the last
 * physical line (a terminal newline is not another line). Never echo queue text.
 */
import { redactSecrets } from "../servers/_crash-dump.ts";
import { defaultRunsRoot, readFleetBuffer } from "./lib/fleet-common.ts";

const FILES = { events: "router-events.log", codex: "queue-author-codex.log", queue: "ROUTER-QUEUE.md" } as const;
const lines = (text: string) => text.replace(/\r?\n$/, "").split(/\r?\n/);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// A credential key is a token run (possibly quoted at either end) whose last word segment is a keyword.
// The lookbehind gates attempts to run starts, so a failed keyword check never re-scans the run.
export const CRED_KEY = /(?:token|secret|password|api[_-]?key)$/i;
export const CRED_VALUE = /(?<![^\s,;:=])([^\s,;:=]+)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;

export function fleetAuthor(events: string, codex: string, queue: Buffer, now = Date.now()) {
  let latest: number | null = null;
  for (const line of lines(events)) {
    let timestamp: unknown;
    try {
      const row = JSON.parse(line);
      if ((row?.event ?? row?.type) === "AUTOAUTHOR") timestamp = row.timestamp ?? row.ts ?? row.time;
    } catch {
      if (/\bAUTOAUTHOR\b/.test(line)) timestamp = line.match(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)/)?.[0];
    }
    const time = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(time) && time <= now && (latest === null || time > latest)) latest = time;
  }
  const error = lines(codex).findLast(line => /\b(error|fatal|panic|exception)\b/i.test(line));
  // Redact before truncating, so a cut cannot hide the suffix of a credential.
  const lastError = error === undefined ? null : redactSecrets(error)
    .replace(CRED_VALUE, (match, key: string, separator: string) =>
      CRED_KEY.test(key.replace(/["']$/, "")) ? key + separator + "[REDACTED]" : match)
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
    .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, "[REDACTED]").slice(0, 1000);
  const splitLines: { line: number; lines_from_tail: number }[] = [];
  // Decode fatally before re-encoding: malformed input is not a clean queue.
  const rows = lines(utf8.decode(queue));
  for (const [index, row] of rows.entries()) {
    if (!/(?:^|[\s|])(?:READY|CLAIMED)(?=$|[\s|])/.test(row)) continue;
    const bytes = Buffer.from(row);
    try { utf8.decode(bytes.subarray(0, 160)); }
    catch { splitLines.push({ line: index + 1, lines_from_tail: rows.length - index - 1 }); }
  }
  return { last_autoauthor_age_s: latest === null ? null : (now - latest) / 1000,
    last_codex_error: lastError, queue_status: splitLines.length ? "split_utf8" : "ok", split_lines: splitLines };
}

export function readFleetAuthor() {
  const errors: Record<string, string> = {};
  const read = (key: keyof typeof FILES): Buffer => {
    try {
      return readFleetBuffer(defaultRunsRoot(), FILES[key]);
    } catch (error) {
      errors[key] = (error as NodeJS.ErrnoException).code ?? "unavailable";
      return Buffer.alloc(0);
    }
  };
  const events = read("events"), codex = read("codex"), queue = read("queue");
  let report;
  try { report = fleetAuthor(events.toString("utf8"), codex.toString("utf8"), queue); }
  catch {
    errors.queue = "invalid_utf8";
    report = fleetAuthor(events.toString("utf8"), codex.toString("utf8"), Buffer.alloc(0));
  }
  return { ...report, queue_status: errors.queue ? "unknown" : report.queue_status, errors };
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    console.log(JSON.stringify({ error: "Usage: bun scripts/fleet-author.ts (no arguments)" }));
    process.exitCode = 1;
  } else {
    const report = readFleetAuthor();
    console.log(JSON.stringify(report));
    if (Object.keys(report.errors).length) process.exitCode = 1;
  }
}
