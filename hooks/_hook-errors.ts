/**
 * _hook-errors.ts — shared error-surfacing helper for hooks.
 *
 * Hooks are best-effort and never block tool calls, but silent catches make
 * production failures undebuggable. This helper surfaces errors two ways:
 *   1. stderr — visible in `claude --debug` and most harness log captures
 *   2. ~/.ashlr/hook-errors.jsonl — persistent ring buffer (cap 1000 lines)
 *
 * Never throws. Never blocks. Safe to call from any catch block.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const MAX_LINES = 1000;
const TRIM_TO = 800;

function errorsPath(): string {
  const home =
    process.env.ASHLR_HOME_OVERRIDE?.trim() ||
    process.env.HOME ||
    homedir();
  return join(home, ".ashlr", "hook-errors.jsonl");
}

function trimIfOversized(p: string): void {
  try {
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n");
    if (lines.length <= MAX_LINES) return;
    const kept = lines.slice(lines.length - TRIM_TO).join("\n");
    writeFileSync(p, kept, "utf-8");
  } catch {
    /* best-effort */
  }
}

/**
 * Safe JSON.parse wrapper — the canonical helper for all hook stdin / config
 * file parsing. Returns `fallback` on any parse error and optionally records
 * the failure via `noteHookError` so it shows up in hook-errors.jsonl.
 *
 * Usage:
 *   const payload = safeParse<MyType>(raw, {}, "my-hook", "stdin");
 *
 * @param raw      - Raw string to parse (may be empty, truncated, or garbage).
 * @param fallback - Value to return when parsing fails.
 * @param hook     - Hook name for error logging (optional; omit to skip logging).
 * @param context  - Context label for error logging (optional).
 */
export function safeParse<T>(
  raw: string,
  fallback: T,
  hook?: string,
  context?: string,
): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    if (hook) noteHookError(hook, context ?? "JSON.parse", e);
    return fallback;
  }
}

export function noteHookError(hook: string, context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[ashlr ${hook}] ${context}: ${msg}\n`);
  } catch {
    /* stderr may be closed in some hook harnesses — swallow */
  }
  try {
    const p = errorsPath();
    mkdirSync(dirname(p), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      context,
      error: msg,
    });
    appendFileSync(p, line + "\n", "utf-8");
    if (Math.random() < 0.01) trimIfOversized(p);
  } catch {
    /* persistence is best-effort */
  }
}
