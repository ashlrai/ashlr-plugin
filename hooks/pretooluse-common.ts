/**
 * pretooluse-common.ts — Shared helpers for the pretooluse-{read,grep,edit}
 * hooks. Each hook shells out via its own `bun run` entry in hooks.json, so we
 * keep this module dependency-free and side-effect-free.
 *
 * Every helper is designed around the "fail open" contract: if anything looks
 * unexpected we let the built-in tool call proceed by exiting 0, rather than
 * blocking the agent with an error.
 */

import { appendFile, appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, dirname, join, sep } from "path";
import { fileURLToPath } from "url";

import {
  findSummarizer,
  isLargeDiffCommand,
} from "../servers/_bash-summarizers-registry";

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
  command: string;
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
      command: typeof input.command === "string" ? input.command : "",
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

// ---------------------------------------------------------------------------
// Memoized realpath — resolves each unique path only once per hook process.
// Calling realpathSync twice per hook (once for cwd, once for the target) on
// NFS/cloud-mount drives adds measurable latency when hooks fire 3-5× per MCP
// call. The cache is process-scoped so test isolation is automatic.
// ---------------------------------------------------------------------------
const _realpathCache = new Map<string, string>();
function cachedRealpath(p: string): string {
  const cached = _realpathCache.get(p);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    result = realpathSync(p);
  } catch {
    result = p;
  }
  _realpathCache.set(p, result);
  return result;
}

export function isInsideCwd(p: string, cwd: string = process.cwd()): boolean {
  if (!p) return false;
  try {
    const absP = resolve(p);
    const absCwd = resolve(cwd);
    const realP = cachedRealpath(absP);
    const realCwd = cachedRealpath(absCwd);
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
// Hook-mode resolution — v1.18 redirect vs. nudge vs. off
// ---------------------------------------------------------------------------
//
// "redirect" (default): PreToolUse hooks BLOCK the native Read/Grep/Edit call
// and instruct the agent to call the equivalent ashlr__* MCP tool instead.
// The block is emitted as structured JSON on stdout using the PreToolUse
// `permissionDecision: "deny"` contract so Claude Code surfaces the reason
// back to the model without raising a user permission prompt.
//
// "nudge" (escape hatch, ASHLR_HOOK_MODE=nudge): preserves the pre-v1.18
// behavior — the pretooluse hooks never block; instead they inject
// `additionalContext` as a soft suggestion the model may or may not follow.
// Previously this was the job of the now-retired hooks/tool-redirect.ts —
// the nudge text and thresholds have been absorbed into this module so we
// ship a single PreToolUse hook per tool rather than two.
//
// "off" (total pass-through): no block, no nudge. Selected by the legacy
// `~/.ashlr/settings.json { "toolRedirect": false }` kill switch, or by
// setting `ASHLR_HOOK_MODE=off` / `hookMode: "off"` in config.json.
//
// Priority order (highest first):
//   1. `ASHLR_HOOK_MODE` env var — "redirect" | "nudge" | "off"
//   2. `~/.ashlr/config.json` `hookMode` field
//   3. `~/.ashlr/settings.json` `toolRedirect: false` → resolves to "off"
//   4. Default: "redirect"
//
// Legacy back-compat: `ASHLR_ENFORCE=1` still selects the exit-code-based
// block path in the individual hooks. That flag is honored independently so
// older harness configurations (and the pretouse hook-timings tests that
// spawn with `ASHLR_ENFORCE=1`) keep working unchanged.

export type HookMode = "redirect" | "nudge" | "off";

function normalizeMode(v: unknown): HookMode | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "redirect" || s === "nudge" || s === "off") return s;
  return null;
}

/**
 * True when the legacy `~/.ashlr/settings.json { toolRedirect: false }` kill
 * switch is in effect. Absent file, malformed JSON, or any other error →
 * treated as "not disabled" (safe default).
 *
 * This helper was ported from the retired hooks/tool-redirect.ts so the
 * settings-based opt-out keeps working after that hook is removed.
 */
export function isRedirectEnabled(home: string = process.env.HOME ?? homedir()): boolean {
  try {
    const settingsPath = join(home, ".ashlr", "settings.json");
    if (!existsSync(settingsPath)) return true;
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      toolRedirect?: boolean;
    };
    return raw.toolRedirect !== false;
  } catch {
    return true;
  }
}

/**
 * Resolve the active hook mode. Never throws — on any read/parse error we
 * fall through to the default ("redirect").
 */
export function getHookMode(home: string = process.env.HOME ?? homedir()): HookMode {
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
    /* ignore — fall through to next check */
  }
  // Legacy kill switch: ~/.ashlr/settings.json { toolRedirect: false } → "off"
  if (!isRedirectEnabled(home)) return "off";
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
 * Empty pass-through JSON — used in "off" mode and for out-of-scope paths
 * where we want Claude Code to proceed with the native tool unaltered.
 */
export function buildPassThrough(): {
  hookSpecificOutput: { hookEventName: "PreToolUse" };
} {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
}

/**
 * Hook-output shape for a soft nudge — inject `additionalContext` so the
 * agent sees the ashlr__* suggestion, but NEVER set `permissionDecision`
 * (doing so would force a permission prompt even in bypassPermissions mode).
 * The native Read/Grep/Edit call proceeds unchanged.
 */
export interface NudgeOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext: string;
  };
}

/**
 * Size threshold below which Read nudges are skipped — tiny files have
 * nothing to compact, so we pass through silently. Matches the snipCompact
 * threshold used by the efficiency-server's ashlr__read implementation.
 *
 * Kept as a named constant so it can be overridden in tests and shared
 * across the redirect + nudge paths for consistency.
 */
export const NUDGE_READ_THRESHOLD = 2048;

/**
 * Build the `additionalContext` nudge payload for a given tool invocation.
 * Returns null when the tool is uninteresting (unknown name, tiny file, etc.)
 * so the caller can fall back to {@link buildPassThrough}.
 *
 * Nudge wording was ported verbatim from the retired hooks/tool-redirect.ts
 * — it has shipped in production for multiple releases and is known to
 * reliably coax the agent into the ashlr__* equivalents.
 *
 * Never throws. Any filesystem / parse error → null (silent pass-through).
 */
export function buildNudgeContext(
  toolName: string,
  toolInput: Record<string, unknown>,
): NudgeOutput | null {
  switch (toolName) {
    case "Read": {
      const filePath =
        typeof toolInput.file_path === "string" ? toolInput.file_path : null;
      if (!filePath) return null;
      const size = fileSize(filePath);
      if (size === null) return null;
      if (size <= NUDGE_READ_THRESHOLD) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[ashlr] Prefer the MCP tool \`ashlr__read\` for files larger than 2KB. ` +
            `It returns a snipCompact-truncated view (head + tail, elided middle) ` +
            `instead of the full ${size}-byte payload. Call it with { "path": "${filePath}" }.`,
        },
      };
    }
    case "Grep": {
      const pattern =
        typeof toolInput.pattern === "string" ? toolInput.pattern : "<pattern>";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[ashlr] Prefer the MCP tool \`ashlr__grep\` over the built-in Grep. ` +
            `When .ashlrcode/genome/ exists it returns the most relevant ` +
            `pre-summarized sections; otherwise it falls back to a truncated ` +
            `ripgrep result. Call it with { "pattern": ${JSON.stringify(pattern)} }.`,
        },
      };
    }
    case "Edit": {
      const filePath =
        typeof toolInput.file_path === "string" ? toolInput.file_path : "<path>";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[ashlr] Prefer the MCP tool \`ashlr__edit\` over the built-in Edit. ` +
            `It applies an in-place strict-by-default search/replace and returns ` +
            `only a compact diff summary, avoiding the full file round-trip. ` +
            `Call it with { "path": "${filePath}", "search": ..., "replace": ..., "strict": true }.`,
        },
      };
    }
    case "Write": {
      const filePath =
        typeof toolInput.file_path === "string" ? toolInput.file_path : "<path>";
      // Only nudge for rewrites of existing files — Write on a new file has
      // no ashlr equivalent (ashlr__edit requires a search string).
      if (fileSize(filePath) === null) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[ashlr] You're rewriting an existing file with the built-in Write tool. ` +
            `For a targeted change, prefer \`ashlr__edit\` with a search/replace pair — ` +
            `it returns only a compact diff summary instead of echoing the full new file. ` +
            `Call it with { "path": "${filePath}", "search": ..., "replace": ..., "strict": true }. ` +
            `If you genuinely need a full rewrite, Write is fine.`,
        },
      };
    }
    case "MultiEdit": {
      const filePath =
        typeof toolInput.file_path === "string" ? toolInput.file_path : "<path>";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[ashlr] Prefer the MCP tool \`ashlr__multi_edit\` over the built-in MultiEdit. ` +
            `It applies all edits atomically (full rollback on any failure) and returns ` +
            `one consolidated diff summary. Call it with { "edits": [{ "path": "${filePath}", "search": ..., "replace": ... }, ...] }.`,
        },
      };
    }
    case "Bash": {
      const command =
        typeof toolInput.command === "string" ? toolInput.command : "";
      if (!command) return null;
      // Only nudge for commands where ashlr__bash can actually compress output.
      // Quiet commands (echo, pwd, mv, rm, simple greps) pass through silently
      // so the agent isn't pestered on every shell call. The match is the
      // same predicate ashlr__bash uses internally to decide whether to apply
      // a structured summarizer (findSummarizer) or LLM diff compression
      // (isLargeDiffCommand) — so a nudge here means "real savings are on
      // the table for this exact command."
      const matches =
        findSummarizer(command) !== null || isLargeDiffCommand(command);
      if (!matches) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[ashlr] This shell command typically produces verbose output. ` +
            `Prefer the MCP tool \`ashlr__bash\` — it auto-compresses long stdout ` +
            `(head + tail with elided middle) and emits structured summaries for ` +
            `common commands (git status/log, npm/bun install, test runners, ` +
            `find, ls, ps, docker ps, tsc). Call it with { "command": ${JSON.stringify(command)} }.`,
        },
      };
    }
    default:
      return null;
  }
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
// `/ashlr-hook-timings` can surface real p50/p95 numbers.
//
// Design rules:
//   - Never throw. Telemetry that breaks the hook is worse than no telemetry.
//   - Respect `ASHLR_HOOK_TIMINGS=0` as a kill switch.
//   - Cap record size — no arbitrary fields from the caller.
//   - Async + batched: writes are queued in memory and flushed via
//     setImmediate (end of current event loop turn) + a 1-second interval
//     guard. On process exit the pending queue is drained synchronously so
//     short-lived subprocess hooks always persist their record before dying.

/** Resolve the timings log path at call time so tests overriding HOME work. */
function hookTimingsPath(): string {
  return join(process.env.HOME ?? homedir(), ".ashlr", "hook-timings.jsonl");
}

function timingsEnabled(): boolean {
  return process.env.ASHLR_HOOK_TIMINGS !== "0";
}

// ---------------------------------------------------------------------------
// Async write batcher — collects JSONL lines and flushes them as a single
// appendFile call. setImmediate drains at end of the current event-loop turn;
// a 1-second interval is a safety net for long-running hooks.
// On process exit, any remaining lines are written synchronously so that
// short-lived subprocess hooks (which call process.exit immediately after
// recording) always persist their record.
// ---------------------------------------------------------------------------
let _pendingLines: string[] = [];
let _flushScheduled = false;
let _flushInterval: ReturnType<typeof setInterval> | null = null;
let _exitHandlerInstalled = false;

function _ensureFlushInterval(): void {
  if (_flushInterval !== null) return;
  _flushInterval = setInterval(_flushBatchAsync, 1000);
  // Don't keep the process alive for the interval alone.
  if (typeof _flushInterval.unref === "function") _flushInterval.unref();
}

function _ensureExitHandler(): void {
  if (_exitHandlerInstalled) return;
  _exitHandlerInstalled = true;
  // process.on("exit") fires synchronously on process.exit(); it is the
  // last chance to do synchronous I/O before the process dies. We drain
  // any pending lines here so subprocess hooks that call process.exit(0)
  // immediately after recordHookTiming() always write their record.
  process.on("exit", () => {
    if (_pendingLines.length === 0) return;
    const batch = _pendingLines.join("");
    _pendingLines = [];
    const path = hookTimingsPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, batch, "utf-8");
    } catch {
      /* swallow — telemetry errors must never surface */
    }
  });
}

function _flushBatchAsync(): void {
  _flushScheduled = false;
  if (_pendingLines.length === 0) return;
  const batch = _pendingLines.join("");
  _pendingLines = [];
  const path = hookTimingsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return;
  }
  appendFile(path, batch, "utf-8", () => {
    // Silent fail — telemetry errors must never surface to the user.
  });
}

/**
 * Record one hook invocation to the timings log. Non-blocking — the write is
 * queued and flushed asynchronously (or synchronously on process exit). Never
 * throws.
 */
export function recordHookTiming(record: {
  hook: string;
  tool?: string;
  durationMs: number;
  outcome: "ok" | "bypass" | "block" | "error";
}): void {
  if (!timingsEnabled()) return;
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        hook: record.hook,
        tool: record.tool ?? null,
        durationMs: Math.max(0, Math.round(record.durationMs)),
        outcome: record.outcome,
      }) + "\n";
    _pendingLines.push(line);
    _ensureFlushInterval();
    _ensureExitHandler();
    if (!_flushScheduled) {
      _flushScheduled = true;
      setImmediate(_flushBatchAsync);
    }
  } catch {
    /* swallow */
  }
}

/**
 * Flush any pending timing lines. Exposed for tests that need to assert on
 * file contents without waiting for the async batcher or process exit.
 * Returns a Promise that resolves once the write completes (or immediately if
 * the queue is empty).
 */
export function flushHookTimings(): Promise<void> {
  return new Promise((resolve) => {
    if (_pendingLines.length === 0) {
      resolve();
      return;
    }
    const batch = _pendingLines.join("");
    _pendingLines = [];
    _flushScheduled = false;
    const path = hookTimingsPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      resolve();
      return;
    }
    appendFile(path, batch, "utf-8", () => resolve());
  });
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
