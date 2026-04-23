/**
 * pretooluse-common.ts — Shared helpers for the pretooluse-{read,grep,edit}
 * hooks. Each hook shells out via its own `bun run` entry in hooks.json, so we
 * keep this module dependency-free and side-effect-free.
 *
 * Every helper is designed around the "fail open" contract: if anything looks
 * unexpected we let the built-in tool call proceed by exiting 0, rather than
 * blocking the agent with an error.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
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
 * True when the absolute path `p` lies inside the working directory `cwd`.
 * Used by redirect mode as a safety net — we never block tool calls against
 * paths the user didn't explicitly bring into scope (e.g. /tmp, /etc, other
 * projects). Falls back to nudge in that case.
 *
 * Canonicalizes via realpath when possible so symlinked roots (notably
 * macOS's /tmp → /private/tmp) match correctly. Plain `resolve()` only
 * normalizes `..`/`.` segments — it does NOT follow symlinks.
 */
export function isInsideCwd(p: string, cwd: string = process.cwd()): boolean {
  if (!p) return false;
  try {
    const absP = resolve(p);
    const absCwd = resolve(cwd);
    const realP = (() => { try { return realpathSync(absP); } catch { return absP; } })();
    const realCwd = (() => { try { return realpathSync(absCwd); } catch { return absCwd; } })();
    for (const base of new Set([absCwd, realCwd])) {
      for (const target of new Set([absP, realP])) {
        if (target === base) return true;
        if (target.startsWith(base + sep)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook-mode resolution — v1.18 redirect vs. nudge
// ---------------------------------------------------------------------------
//
// "redirect" (default): PreToolUse hooks BLOCK the native Read/Grep/Edit call
// and instruct the agent to call the equivalent ashlr__* MCP tool instead.
// The block is emitted as structured JSON on stdout using the PreToolUse
// `permissionDecision: "deny"` contract so Claude Code surfaces the reason
// back to the model without raising a user permission prompt.
//
// "nudge" (escape hatch, ASHLR_HOOK_MODE=nudge): preserves the old v1.17
// behavior — the pretooluse hooks become silent no-ops, and the separate
// tool-redirect.ts hook continues to inject `additionalContext` as a soft
// suggestion that the model may or may not follow.
//
// Priority order (highest first):
//   1. `ASHLR_HOOK_MODE` env var — "redirect" | "nudge"
//   2. `~/.ashlr/config.json` `hookMode` field
//   3. Default: "redirect"
//
// Legacy back-compat: `ASHLR_ENFORCE=1` still selects the exit-code-based
// block path in the individual hooks. That flag is honored independently so
// older harness configurations (and the pretouse hook-timings tests that
// spawn with `ASHLR_ENFORCE=1`) keep working unchanged.

export type HookMode = "redirect" | "nudge";

function normalizeMode(v: unknown): HookMode | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "redirect" || s === "nudge") return s;
  return null;
}

/**
 * Resolve the active hook mode. Never throws — on any read/parse error we
 * fall through to the default ("redirect").
 */
export function getHookMode(home: string = homedir()): HookMode {
  const envMode = normalizeMode(process.env.ASHLR_HOOK_MODE);
  if (envMode) return envMode;
  try {
    const cfgPath = join(home, ".ashlr", "config.json");
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as { hookMode?: unknown };
      const fileMode = normalizeMode(raw?.hookMode);
      if (fileMode) return fileMode;
    }
  } catch {
    /* ignore — fall through to default */
  }
  return "redirect";
}

/**
 * Hook-output shape for a PreToolUse block that routes the agent to an
 * ashlr__* MCP tool. Claude Code surfaces `permissionDecisionReason` back to
 * the model so it can re-issue the call against the suggested tool without
 * raising a user-facing permission prompt.
 */
export interface RedirectBlockOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/** Build a redirect-block JSON payload. Pure — no side effects. */
export function buildRedirectBlock(reason: string): RedirectBlockOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Silent pass-through JSON for nudge mode. tool-redirect.ts handles the
 * `additionalContext` nudge separately, so this hook emits an empty envelope.
 */
export function buildPassThrough(): {
  hookSpecificOutput: { hookEventName: "PreToolUse" };
} {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
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
