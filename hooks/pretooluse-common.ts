/**
 * pretooluse-common.ts — Shared helpers for the pretooluse-{read,grep,edit}
 * hooks. Each hook shells out via its own `bun run` entry in hooks.json, so we
 * keep this module dependency-free and side-effect-free.
 *
 * Every helper is designed around the "fail open" contract: if anything looks
 * unexpected we let the built-in tool call proceed by exiting 0, rather than
 * blocking the agent with an error.
 */

import { appendFileSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, dirname, join, sep } from "path";
import { fileURLToPath } from "url";

/**
 * True when enforcement is disabled — the hook should exit 0 immediately.
 *
 * Enforcement is OFF by default. Only enable when `ASHLR_ENFORCE=1` is set,
 * and still honor `ASHLR_NO_ENFORCE=1` as a kill switch for back-compat.
 */
export function enforcementDisabled(): boolean {
  return process.env.ASHLR_ENFORCE !== "1" || process.env.ASHLR_NO_ENFORCE === "1";
}

/** Read the full stdin payload as a UTF-8 string (trimmed). */
export function readStdin(): Promise<string> {
  // Parameter name avoids shadowing the `resolve` imported from "path" above.
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => {
      done(Buffer.concat(chunks).toString("utf-8").trim());
    });
  });
}

export interface PreToolUsePayload {
  tool_name: string;
  file_path: string;
  pattern: string;
  search_path: string;
  bypass: boolean;
}

/**
 * Parse a pretooluse JSON payload. Returns null if the input is empty or
 * malformed (the caller should exit 0 in that case). Missing fields come back
 * as empty strings / false so call-sites can stay uniform.
 */
export function parsePayload(raw: string): PreToolUsePayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const input = p?.tool_input ?? {};
    return {
      tool_name: typeof p?.tool_name === "string" ? p.tool_name : "",
      file_path: typeof input.file_path === "string" ? input.file_path : "",
      pattern: typeof input.pattern === "string" ? input.pattern : "",
      search_path: typeof input.path === "string" ? input.path : "",
      bypass: input.bypassSummary === true,
    };
  } catch {
    return null;
  }
}

/** Absolute path to the plugin root, derived from the calling hook's URL. */
export function pluginRootFrom(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

/** True when `p` lies inside the plugin's own directory tree. */
export function isInsidePluginRoot(p: string, pluginRoot: string): boolean {
  if (!p) return false;
  if (p === pluginRoot) return true;
  return p.startsWith(pluginRoot + sep);
}

/**
 * Return the file size in bytes, or null if the path isn't a regular file
 * (doesn't exist, is a dir, permission denied, etc.). Never throws.
 */
export function fileSize(filePath: string): number | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    return st.size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook-timing telemetry
// ---------------------------------------------------------------------------
//
// Every PreToolUse hook is a separate subprocess spawned by Claude Code.
// Users who suspect hooks are slow (common on network-drive projects) have
// no way to see which hook is the culprit. These helpers append a single
// JSONL record per invocation to `~/.ashlr/hook-timings.jsonl` so
// `/ashlr-hook-timings` (future) can surface real p50/p95 numbers.
//
// Design rules:
//   - Never throw. Telemetry that breaks the hook is worse than no telemetry.
//   - Respect `ASHLR_HOOK_TIMINGS=0` as a kill switch.
//   - Cap record size — no arbitrary fields from the caller.

/** Resolve the timings log path at call time so tests overriding HOME work. */
function hookTimingsPath(): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "hook-timings.jsonl");
}

function timingsEnabled(): boolean {
  return process.env.ASHLR_HOOK_TIMINGS !== "0";
}

/**
 * Record one hook invocation to the timings log. Fire-and-forget — never
 * throws, never blocks past a best-effort synchronous append.
 */
export function recordHookTiming(record: {
  hook: string;
  tool?: string;
  durationMs: number;
  outcome: "ok" | "bypass" | "block" | "error";
}): void {
  if (!timingsEnabled()) return;
  try {
    const path = hookTimingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        hook: record.hook,
        tool: record.tool ?? null,
        durationMs: Math.max(0, Math.round(record.durationMs)),
        outcome: record.outcome,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* swallow */
  }
}

/**
 * Wrap a hook's main function in timing instrumentation. The callback returns
 * the hook's outcome classification so the timings log distinguishes
 * "took 2ms and did nothing" from "took 300ms and blocked the call".
 */
export async function withHookTiming<T>(
  hookName: string,
  fn: () => Promise<{ value: T; outcome: "ok" | "bypass" | "block" | "error"; tool?: string }>,
): Promise<T> {
  const start = Date.now();
  try {
    const { value, outcome, tool } = await fn();
    recordHookTiming({ hook: hookName, tool, durationMs: Date.now() - start, outcome });
    return value;
  } catch (err) {
    recordHookTiming({ hook: hookName, durationMs: Date.now() - start, outcome: "error" });
    throw err;
  }
}
