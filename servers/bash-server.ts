#!/usr/bin/env bun
/**
 * ashlr-bash MCP server.
 *
 * Exposes ashlr__bash — a token-efficient replacement for Claude Code's
 * built-in Bash tool. Auto-compresses long stdout, recognizes a handful of
 * common commands and returns compact structured summaries instead of raw
 * output, and refuses catastrophic patterns. stderr is never compressed —
 * errors must reach the agent intact.
 *
 * Persists savings to ~/.ashlr/stats.json using the same schema as the
 * efficiency server so the status line aggregates cleanly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import {
  summarizeGitStatus,
  summarizeLs,
  summarizeFind,
  summarizePs,
  summarizeNpmLs,
  summarizeDockerPs,
  summarizeKubectlGet,
  summarizeNpmAudit,
  findSummarizer,
  isLargeDiffCommand,
  DIFF_LLM_THRESHOLD_BYTES,
} from "./_bash-summarizers-registry.js";

/**
 * Resolve the shell to use for executing commands.
 * On Windows, use PowerShell (pwsh preferred, powershell fallback) with -Command.
 * On POSIX, use $SHELL or /bin/sh.
 * Returns [shellBin, shellArgs] — the command is appended to shellArgs.
 */
function resolveShell(): [string, string[]] {
  if (process.platform === "win32") {
    const pwsh =
      typeof (globalThis as { Bun?: { which(b: string): string | null } }).Bun !== "undefined"
        ? (globalThis as { Bun: { which(b: string): string | null } }).Bun.which("pwsh") ??
          (globalThis as { Bun: { which(b: string): string | null } }).Bun.which("powershell")
        : null;
    const bin = pwsh ?? "powershell";
    return [bin, ["-NoProfile", "-NonInteractive", "-Command"]];
  }
  return [process.env.SHELL || "/bin/sh", ["-c"]];
}
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { recordSaving as recordSavingCore } from "./_stats";
import { logEvent } from "./_events";
import { clampToCwd } from "./_cwd-clamp";

// Bash always records under the "ashlr__bash" tool bucket.
async function recordSaving(rawBytes: number, compactBytes: number): Promise<number> {
  return recordSavingCore(rawBytes, compactBytes, "ashlr__bash");
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

const COMPRESS_THRESHOLD = 2048;
// Head/tail sizes were tuned for the dominant case: build/test/install logs
// where the failing assertion or stack trace lands in the last few hundred
// bytes, while the head establishes which command/phase produced the output.
// 800 head + 800 tail keeps the structural signal on both ends and still
// fits comfortably under typical 2KB token budgets after framing.
const HEAD_BYTES = 800;
const TAIL_BYTES = 800;
// On a failing command (non-zero exit), the last 4KB almost certainly holds
// the error stack. We expand the tail so errors are never lost to elision.
const FAIL_TAIL_BYTES = 4096;

interface SnipOptions {
  /** When true, emit a sharper warning that an error may be in the elided gap. */
  errorAware?: boolean;
  /** When true, expand tail capture so non-zero-exit errors aren't dropped. */
  exitedNonZero?: boolean;
}

function snipBytes(s: string, opts: SnipOptions = {}): { out: string; saved: number } {
  if (s.length <= COMPRESS_THRESHOLD) return { out: s, saved: 0 };
  const tailBytes = opts.exitedNonZero ? FAIL_TAIL_BYTES : TAIL_BYTES;
  // If expanding the tail would take us over the full length, just emit raw.
  if (HEAD_BYTES + tailBytes >= s.length) return { out: s, saved: 0 };
  const elided = s.length - HEAD_BYTES - tailBytes;
  const warning = opts.errorAware
    ? `\n[... ${elided.toLocaleString()} bytes elided · LLM summary unavailable · an error may be in this gap · pass bypassSummary:true for the full output ...]\n`
    : `\n[... ${elided.toLocaleString()} bytes of output elided ...]\n`;
  const out = s.slice(0, HEAD_BYTES) + warning + s.slice(-tailBytes);
  return { out, saved: s.length - out.length };
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const DANGEROUS = [
  /\brm\s+-rf?\s+\/(?:\s|$)/,            // rm -rf /
  /\brm\s+-rf?\s+\/\*/,                  // rm -rf /*
  /\brm\s+-rf?\s+~(?:\s|$)/,             // rm -rf ~
  /\brm\s+-rf?\s+\$HOME(?:\s|$)/,        // rm -rf $HOME
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;\s*:/,    // fork bomb
  /\bmkfs(\.\w+)?\b/,                    // mkfs
  /\bdd\s+if=.*of=\/dev\/[sh]d/,         // dd to a raw disk
  />\s*\/dev\/sda/,                      // pipe to raw disk
];

function refusalReason(cmd: string): string | null {
  const trimmed = cmd.trim();
  for (const pat of DANGEROUS) {
    if (pat.test(trimmed)) {
      return `ashlr__bash refused: command matches catastrophic pattern (${pat}). Use Claude Code's built-in Bash if you really intended this.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command-specific summarizers
// ---------------------------------------------------------------------------

interface Summarized {
  text: string;
  rawBytes: number;
  compactBytes: number;
}

function tryCatRefusal(cmd: string): string | null {
  // Detect a leading `cat <file>` (single-file, not a pipe / heredoc / multi-arg).
  const t = cmd.trim();
  if (!/^cat\s+\S/.test(t)) return null;
  if (/[|<>]/.test(t)) return null; // pipe/redirect — leave alone
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;
  // Skip flags except common ones; if all non-flag args are present treat as cat.
  const args = parts.slice(1).filter((a) => !a.startsWith("-"));
  if (args.length === 0) return null;
  return `ashlr__bash refused: use ashlr__read for file contents (path: ${args[0]}). It auto-compresses files > 2KB and tracks savings.`;
}

// Summarizer functions imported from ./_bash-summarizers-registry.js



async function tryStructuredSummary(
  command: string,
  stdout: string,
  cwd: string,
): Promise<string | null> {
  const trimmed = command.trim();

  // git status (porcelain or human) — branch and ahead/behind via separate call.
  if (/^git\s+status(\s|$)/.test(trimmed)) {
    let porcelain = stdout;
    let branchHint: string | undefined;
    if (!/--porcelain/.test(trimmed)) {
      // Re-run a porcelain query to compute counts deterministically.
      try {
        const r = await runRaw("git status --porcelain", cwd, 5000);
        porcelain = r.stdout;
      } catch {
        // Fall back to whatever we have.
      }
    }
    try {
      const b = await runRaw("git rev-parse --abbrev-ref HEAD", cwd, 5000);
      branchHint = b.stdout.trim() || undefined;
    } catch { /* ignore */ }
    let summary = summarizeGitStatus(porcelain, branchHint);
    try {
      const ab = await runRaw("git rev-list --left-right --count @{u}...HEAD", cwd, 5000);
      const m = ab.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) {
        const behind = Number(m[1]);
        const ahead = Number(m[2]);
        if (ahead || behind) summary += ` · ahead ${ahead} behind ${behind}`;
      }
    } catch { /* no upstream — skip */ }
    return summary;
  }

  // ls -la / ls -l
  if (/^ls(\s+-\w+)*(\s|$)/.test(trimmed)) {
    return summarizeLs(stdout);
  }

  // find . -name ...
  if (/^find\s/.test(trimmed)) {
    return summarizeFind(stdout);
  }

  // ps aux / ps -ef
  if (/^ps\s+(aux|-ef)\b/.test(trimmed)) {
    return summarizePs(stdout, cwd);
  }

  // npm ls / bun pm ls
  if (/^(npm\s+ls|bun\s+pm\s+ls)\b/.test(trimmed)) {
    return summarizeNpmLs(stdout);
  }

  // docker ps / docker-compose ps
  if (/^(docker(-compose)?\s+ps|docker\s+container\s+ls)\b/.test(trimmed)) {
    return summarizeDockerPs(stdout);
  }

  // kubectl get <resource>
  if (/^kubectl\s+get\b/.test(trimmed)) {
    return summarizeKubectlGet(stdout);
  }

  // npm audit (text or --json)
  if (/^npm\s+audit\b/.test(trimmed)) {
    return summarizeNpmAudit(stdout);
  }

  // Fallback: route through the v1.18 registry so new summarizers (git log,
  // test runners, tsc, package installs) fire without per-command branches.
  const fn = findSummarizer(trimmed);
  if (fn) {
    try {
      const out = fn(stdout);
      if (out !== null && out.length > 0) return out;
    } catch { /* registry summarizers must never throw; fall through */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

function runRaw(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolveP) => {
    const start = Date.now();
    // Use resolveShell() for cross-platform shell selection.
    // On Windows: PowerShell (pwsh/powershell) with -Command.
    // On POSIX: $SHELL or /bin/sh with -c.
    const [shell, shellArgs] = resolveShell();
    // On POSIX, `detached: true` gives the child its own process group so we
    // can later SIGKILL the whole group (`-pid`) instead of just the shell —
    // otherwise forked grandchildren (npm install, cargo build, etc.) leak
    // and keep running after timeout. Windows has no process groups, so we
    // stick with the default spawn options and fall back to child.kill().
    const isWin = process.platform === "win32";
    const child = spawn(shell, [...shellArgs, command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWin,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 5 * 1024 * 1024; // 5MB hard cap to avoid OOM on runaway output
    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < cap) stdout += b.toString("utf-8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < cap) stderr += b.toString("utf-8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (isWin) {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      } else if (child.pid != null) {
        // Negative pid => kill the process group. Wrapped in try/catch because
        // the group may already be gone (exited between timer fire and kill).
        try { process.kill(-child.pid, "SIGKILL"); } catch {
          // Fall back to killing just the shell if the group call failed
          // (e.g. ESRCH because the leader already reaped).
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }
      } else {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr,
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        exitCode: 127,
        signal: null,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

export interface BashArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  compact?: boolean;
  bypassSummary?: boolean;
}

export async function ashlrBash(args: BashArgs): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    return "ashlr__bash error: 'command' is required";
  }
  // Clamp the shell's working directory to process.cwd() so a prompt-injected
  // caller can't pivot the shell to /, $HOME, or any ancestor — which would
  // defeat the content-focused refusals below (tryCatRefusal only checks the
  // command string, not the effective directory) and expose parent repos.
  const clamp = clampToCwd(args.cwd, "ashlr__bash");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;
  const timeoutMs = args.timeout_ms ?? 60_000;
  const compact = args.compact !== false;

  const refusal = refusalReason(command);
  if (refusal) return `$ ${command}\n${refusal}`;

  const catMsg = tryCatRefusal(command);
  if (catMsg) return `$ ${command}\n${catMsg}`;

  const res = await runRaw(command, cwd, timeoutMs);

  const exitLabel = res.timedOut
    ? `timed out after ${timeoutMs}ms (killed)`
    : res.signal
      ? `killed by ${res.signal}`
      : `exit ${res.exitCode}`;

  const rawStdoutBytes = res.stdout.length;
  let body: string;
  let compactBytes: number;
  let savedNote = "";
  let structuredSummaryFired = false;

  if (compact) {
    const structured = await tryStructuredSummary(command, res.stdout, cwd);
    if (structured !== null) {
      body = structured;
      compactBytes = body.length;
      structuredSummaryFired = true;
    } else if (isLargeDiffCommand(command) && rawStdoutBytes > DIFF_LLM_THRESHOLD_BYTES && !args.bypassSummary) {
      // git diff / git show — route through the diff-specific prompt at a
      // lower threshold (4 KB). Diffs are denser than generic bash output.
      const s = await summarizeIfLarge(res.stdout, {
        toolName: "ashlr__bash",
        systemPrompt: PROMPTS.diff,
        bypass: false,
      });
      if (s.summarized || s.fellBack) {
        body = s.text;
        compactBytes = s.outputBytes;
      } else {
        body = res.stdout;
        compactBytes = rawStdoutBytes;
      }
    } else if (rawStdoutBytes > 16_384 && !args.bypassSummary) {
      // Try LLM summarization on the RAW stdout for large pass-through output.
      // Falls back to snipBytes truncation if the LLM is unreachable / declined.
      const s = await summarizeIfLarge(res.stdout, {
        toolName: "ashlr__bash",
        systemPrompt: PROMPTS.bash,
        bypass: false,
      });
      if (s.summarized || s.fellBack) {
        body = s.text;
        compactBytes = s.outputBytes;
      } else {
        // LLM failed AND we're over the threshold — warn loudly, since the
        // most likely scenario is that an error is hiding in the elided gap.
        const exitedNonZero = res.exitCode != null && res.exitCode !== 0;
        const { out, saved } = snipBytes(res.stdout, {
          errorAware: true,
          exitedNonZero,
        });
        if (exitedNonZero && saved > 0) {
          await logEvent("tool_escalate", {
            tool: "ashlr__bash",
            reason: "nonzero-exit-elided",
            extra: { exitCode: res.exitCode },
          });
        }
        body = out;
        compactBytes = out.length;
        if (saved > 0) savedNote = ` · [compact saved ${saved.toLocaleString()} bytes]`;
      }
    } else {
      // Baseline snip path — widen tail on non-zero exit so errors never drop.
      const { out, saved } = snipBytes(res.stdout, {
        exitedNonZero: res.exitCode != null && res.exitCode !== 0,
      });
      body = out;
      compactBytes = out.length;
      if (saved > 0) savedNote = ` · [compact saved ${saved.toLocaleString()} bytes]`;
    }
  } else {
    body = res.stdout;
    compactBytes = res.stdout.length;
  }

  // Track savings for the stdout side only (stderr is not compressed).
  if (compact && rawStdoutBytes > 0) {
    await recordSaving(rawStdoutBytes, compactBytes);
    if (!savedNote && rawStdoutBytes > compactBytes) {
      savedNote = ` · [compact saved ${(rawStdoutBytes - compactBytes).toLocaleString()} bytes]`;
    } else if (!savedNote) {
      savedNote = " · [compact saved 0 bytes]";
    }
  }

  // stderr passes through uncompressed and labeled.
  const stderrBlock = res.stderr.length > 0
    ? `\n--- stderr ---\n${res.stderr}`
    : "";

  const trailer = `· ${exitLabel} · ${res.durationMs}ms${savedNote}`;
  // Compose: command echo, body, optional stderr, trailer.
  const composed = `$ ${command}\n${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${stderrBlock}${stderrBlock.endsWith("\n") ? "" : "\n"}${trailer}`;

  // Append confidence badge only when compression actually fired.
  if (compact && rawStdoutBytes > compactBytes) {
    const exitedNonZero = res.exitCode != null && res.exitCode !== 0;
    const bashBadgeOpts = {
      toolName: "ashlr__bash",
      rawBytes: rawStdoutBytes,
      outputBytes: compactBytes,
      fellBack: !structuredSummaryFired && rawStdoutBytes > 16_384 && compactBytes < rawStdoutBytes,
      nonZeroExit: exitedNonZero && rawStdoutBytes > compactBytes,
    };
    if (confidenceTier(bashBadgeOpts) === "low") {
      await logEvent("tool_low_confidence_shipped", { tool: "ashlr__bash", reason: "low-confidence" });
    }
    return composed + confidenceBadge(bashBadgeOpts);
  }
  return composed;
}

// ---------------------------------------------------------------------------
// Background sessions (tail mode)
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  proc: ChildProcess | null;
  // tracked separately because ChildProcess stdin/stdout/stderr may be null
  // depending on stdio config — our spawn always uses pipes, but the narrow
  // type is awkward to express.
  stdout: string;
  stderr: string;
  offset: number;        // bytes of stdout the agent has already seen
  stderrOffset: number;
  cumulativeBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
  dataEmitter: Set<() => void>; // wait_ms listeners
}

const SESSIONS = new Map<string, Session>();
// Prefer $HOME when explicitly set (matches the rest of the ashlr codebase).
// On Windows `homedir()` reads USERPROFILE, which causes tests that set HOME
// to leak into the real user profile; honoring $HOME keeps behavior uniform.
const ASHLR_HOME = process.env.HOME ?? homedir();
const SESSIONS_PATH = join(ASHLR_HOME, ".ashlr", "bash-sessions.json");
const MAX_SESSIONS = 16;
const MAX_CUMULATIVE_BYTES = 50 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// External session providers (test-watch, etc.)
//
// Other modules can plug into the bash-session tool surface so ashlr__bash_list
// enumerates their sessions, and ashlr__bash_tail / ashlr__bash_stop route to
// them by id. This keeps one tool surface for all background work without
// coupling bash-server to test-watch internals.
// ---------------------------------------------------------------------------

export interface ExternalSession {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  cumulativeBytes: number;
  kind: string;
}

export interface ExternalSessionProvider {
  kind: string;
  list(): ExternalSession[];
  tail(id: string, waitMs: number, maxBytes: number): Promise<string | null>;
  stop(id: string, signal?: NodeJS.Signals): string | null;
  has(id: string): boolean;
}

const EXTERNAL_PROVIDERS: ExternalSessionProvider[] = [];

export function registerExternalSessions(provider: ExternalSessionProvider): void {
  // Replace any previously-registered provider of the same kind (idempotent
  // on re-import during tests).
  const idx = EXTERNAL_PROVIDERS.findIndex((p) => p.kind === provider.kind);
  if (idx >= 0) EXTERNAL_PROVIDERS[idx] = provider;
  else EXTERNAL_PROVIDERS.push(provider);
}

function findExternalProvider(id: string): ExternalSessionProvider | null {
  for (const p of EXTERNAL_PROVIDERS) {
    if (p.has(id)) return p;
  }
  return null;
}

interface PersistedSession {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  exitCode: number | null;
  cumulativeBytes: number;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function persistSessions(): Promise<void> {
  await mkdir(dirname(SESSIONS_PATH), { recursive: true });
  const payload: PersistedSession[] = [];
  for (const s of SESSIONS.values()) {
    payload.push({
      id: s.id,
      pid: s.pid,
      command: s.command,
      cwd: s.cwd,
      startedAt: s.startedAt,
      exitCode: s.exitCode,
      cumulativeBytes: s.cumulativeBytes,
    });
  }
  await writeFile(SESSIONS_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Load any persisted sessions from a prior server run. We cannot reattach
 * to the stdio of a process we didn't spawn, so we only restore metadata
 * for PIDs that are still alive. Dead PIDs are cleaned up (file pruned).
 * Live "zombie" sessions have no proc — tail will report that output is
 * no longer capturable but the process is still running.
 */
async function reloadSessions(): Promise<void> {
  if (!existsSync(SESSIONS_PATH)) return;
  let raw: PersistedSession[];
  try {
    raw = JSON.parse(await readFile(SESSIONS_PATH, "utf-8"));
  } catch {
    return;
  }
  for (const p of raw) {
    if (!pidAlive(p.pid)) continue; // dead PID — prune
    SESSIONS.set(p.id, {
      id: p.id,
      pid: p.pid,
      command: p.command,
      cwd: p.cwd,
      startedAt: p.startedAt,
      proc: null, // cannot reattach streams
      stdout: "",
      stderr: "",
      offset: 0,
      stderrOffset: 0,
      cumulativeBytes: p.cumulativeBytes,
      exitCode: p.exitCode,
      signal: null,
      timeoutTimer: null,
      lastActivity: Date.now(),
      dataEmitter: new Set(),
    });
  }
  await persistSessions();
}

function newId(): string {
  return randomBytes(4).toString("hex");
}

function gcOldestInactive(): void {
  if (SESSIONS.size < MAX_SESSIONS) return;
  // Prefer evicting an already-exited session; else evict the one with the
  // oldest lastActivity.
  const entries = [...SESSIONS.values()];
  const exited = entries.filter((s) => s.exitCode !== null);
  const candidates = exited.length > 0 ? exited : entries;
  candidates.sort((a, b) => a.lastActivity - b.lastActivity);
  const victim = candidates[0];
  if (victim) {
    try { victim.proc?.kill("SIGKILL"); } catch { /* ignore */ }
    if (victim.timeoutTimer) clearTimeout(victim.timeoutTimer);
    SESSIONS.delete(victim.id);
  }
}

export interface StartArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export async function ashlrBashStart(args: StartArgs): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    return "ashlr__bash_start error: 'command' is required";
  }
  const clamp = clampToCwd(args.cwd, "ashlr__bash_start");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;
  const timeoutMs = args.timeout_ms ?? DEFAULT_START_TIMEOUT_MS;

  const refusal = refusalReason(command);
  if (refusal) return `[refused] ${refusal}`;

  gcOldestInactive();

  const id = newId();
  const [shell, shellArgs] = resolveShell();
  const child = spawn(shell, [...shellArgs, command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess;
  if (!child.stdout || !child.stderr) {
    return `[start] spawn failed: no stdio pipes`;
  }

  const session: Session = {
    id,
    pid: child.pid ?? -1,
    command,
    cwd,
    startedAt: Date.now(),
    proc: child,
    stdout: "",
    stderr: "",
    offset: 0,
    stderrOffset: 0,
    cumulativeBytes: 0,
    exitCode: null,
    signal: null,
    timeoutTimer: null,
    lastActivity: Date.now(),
    dataEmitter: new Set(),
  };

  child.stdout.on("data", (b: Buffer) => {
    const s = b.toString("utf-8");
    session.stdout += s;
    session.cumulativeBytes += b.length;
    session.lastActivity = Date.now();
    if (session.cumulativeBytes > MAX_CUMULATIVE_BYTES) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      session.stderr += `\n[ashlr: session exceeded ${MAX_CUMULATIVE_BYTES} bytes — killed]\n`;
    }
    for (const fn of [...session.dataEmitter]) fn();
  });
  child.stderr.on("data", (b: Buffer) => {
    session.stderr += b.toString("utf-8");
    session.lastActivity = Date.now();
    for (const fn of [...session.dataEmitter]) fn();
  });
  child.on("close", (code, signal) => {
    session.exitCode = code;
    session.signal = signal;
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
    session.lastActivity = Date.now();
    for (const fn of [...session.dataEmitter]) fn();
    persistSessions().catch(() => { /* best-effort */ });
  });
  child.on("error", (err) => {
    session.stderr += `\n[spawn error: ${err.message}]\n`;
    session.exitCode = 127;
    for (const fn of [...session.dataEmitter]) fn();
  });

  session.timeoutTimer = setTimeout(() => {
    if (session.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, timeoutMs);

  SESSIONS.set(id, session);
  await persistSessions();

  return `[started] id=${id} · pid=${session.pid} · $ ${command}`;
}

export interface TailArgs {
  id: string;
  max_bytes?: number;
  wait_ms?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ashlrBashTail(args: TailArgs): Promise<string> {
  const id = args.id;
  const maxBytes = args.max_bytes ?? 2048;
  const waitMs = args.wait_ms ?? 1500;

  // Route to external provider (e.g. test-watch) if it owns this id.
  const ext = findExternalProvider(id);
  if (ext) {
    const out = await ext.tail(id, waitMs, maxBytes);
    if (out !== null) return out;
  }

  const s = SESSIONS.get(id);
  if (!s) return `[tail] unknown id: ${id}`;

  const hasNew = () =>
    s.stdout.length > s.offset ||
    s.stderr.length > s.stderrOffset ||
    s.exitCode !== null;

  if (!hasNew() && waitMs > 0) {
    // Event-driven wait: install a one-shot listener that resolves when new
    // output arrives or the process exits. Fall back to a timeout so we
    // always honor wait_ms as a ceiling.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        s.dataEmitter.delete(notify);
        clearTimeout(t);
        resolve();
      };
      const notify = () => finish();
      const t = setTimeout(finish, waitMs);
      s.dataEmitter.add(notify);
      // Race guard — if data landed between the initial check and now.
      if (hasNew()) finish();
    });
  }

  const newStdout = s.stdout.slice(s.offset);
  const newStderr = s.stderr.slice(s.stderrOffset);
  const newBytes = newStdout.length;
  s.offset = s.stdout.length;
  s.stderrOffset = s.stderr.length;
  s.lastActivity = Date.now();

  // Compress the stdout tail window when it exceeds threshold.
  let body: string;
  if (newStdout.length > COMPRESS_THRESHOLD) {
    const { out } = snipBytes(newStdout);
    body = out;
  } else if (newStdout.length > maxBytes) {
    // Respect caller's max_bytes: keep trailing portion.
    body = `[... ${(newStdout.length - maxBytes).toLocaleString()} bytes elided ...]\n` +
      newStdout.slice(-maxBytes);
  } else {
    body = newStdout;
  }

  const exited = s.exitCode !== null || s.signal !== null;
  const statusLabel = exited
    ? s.signal
      ? `exit ${s.exitCode ?? "?"} · signal ${s.signal}`
      : `exit ${s.exitCode}`
    : "running";
  const header = `[${id} · pid ${s.pid} · ${statusLabel}] +${newBytes} bytes since last poll`;
  const stderrBlock = newStderr.length > 0 ? `\n--- stderr ---\n${newStderr}` : "";
  const output = `${header}\n${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${stderrBlock}`;

  if (exited) {
    // Drop the session after reporting the final tail.
    if (s.timeoutTimer) clearTimeout(s.timeoutTimer);
    SESSIONS.delete(id);
    await persistSessions();
  }
  return output;
}

export interface StopArgs {
  id: string;
  signal?: string;
}

export async function ashlrBashStop(args: StopArgs): Promise<string> {
  const id = args.id;
  const signal = (args.signal ?? "SIGTERM") as NodeJS.Signals;
  // Route to external provider (e.g. test-watch) if it owns this id.
  const ext = findExternalProvider(id);
  if (ext) {
    const out = ext.stop(id, signal);
    if (out !== null) return out;
  }
  const s = SESSIONS.get(id);
  if (!s) return `[stop] unknown id: ${id}`;

  if (s.exitCode !== null) {
    SESSIONS.delete(id);
    await persistSessions();
    return `[${id}] already exited · exit ${s.exitCode}`;
  }

  try { s.proc?.kill(signal); } catch { /* ignore */ }

  // Wait up to 2s; if still alive, SIGKILL.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && s.exitCode === null) {
    await sleep(50);
  }
  if (s.exitCode === null) {
    try { s.proc?.kill("SIGKILL"); } catch { /* ignore */ }
    // Give the close handler a tick.
    const kd = Date.now() + 500;
    while (Date.now() < kd && s.exitCode === null) await sleep(25);
  }

  const exitLabel = s.signal ? `signal ${s.signal}` : `exit ${s.exitCode ?? "?"}`;
  if (s.timeoutTimer) clearTimeout(s.timeoutTimer);
  SESSIONS.delete(id);
  await persistSessions();
  return `[${id}] stopped · ${exitLabel}`;
}

export async function ashlrBashList(): Promise<string> {
  // Collect both native bash sessions and any external providers (test-watch).
  interface Row {
    id: string;
    pid: number;
    startedAt: number;
    cumulativeBytes: number;
    command: string;
    kind: string;
  }
  const rowsData: Row[] = [];
  for (const s of SESSIONS.values()) {
    rowsData.push({
      id: s.id,
      pid: s.pid,
      startedAt: s.startedAt,
      cumulativeBytes: s.cumulativeBytes,
      command: s.command,
      kind: "bash",
    });
  }
  for (const p of EXTERNAL_PROVIDERS) {
    for (const e of p.list()) {
      rowsData.push({
        id: e.id,
        pid: e.pid,
        startedAt: e.startedAt,
        cumulativeBytes: e.cumulativeBytes,
        command: e.command,
        kind: e.kind,
      });
    }
  }

  if (rowsData.length === 0) return "[list] no active sessions";

  const rows: string[] = [
    "id       | kind       | pid     | started           | bytes     | command",
    "---------+------------+---------+-------------------+-----------+--------",
  ];
  for (const r of rowsData) {
    const started = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 19);
    const cmd = r.command.length > 40 ? r.command.slice(0, 37) + "..." : r.command;
    rows.push(
      `${r.id.padEnd(8)} | ${r.kind.padEnd(10)} | ${String(r.pid).padEnd(7)} | ${started} | ${String(r.cumulativeBytes).padEnd(9)} | ${cmd}`,
    );
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-bash", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__bash",
      description:
        "Run a shell command. Auto-compresses stdout > 2KB (head + tail with elided middle), and emits compact structured summaries for common commands (git status, ls, find, ps, npm ls). stderr is never compressed. Refuses catastrophic patterns and `cat <file>` (use ashlr__read instead). Lower-token alternative to the built-in Bash tool.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
          timeout_ms: { type: "number", description: "Kill after N ms (default 60000)" },
          compact: { type: "boolean", description: "Auto-compress long output (default true)" },
          bypassSummary: { type: "boolean", description: "Skip LLM summarization of long output" },
        },
        required: ["command"],
      },
    },
    {
      name: "ashlr__bash_start",
      description:
        "Spawn a long-running shell command in the background and return a session id. Use ashlr__bash_tail to poll incremental output, ashlr__bash_stop to kill, ashlr__bash_list to enumerate. Ideal for watchers, tails, long builds, and anything where streaming >> one-shot.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
          timeout_ms: { type: "number", description: "Max lifetime before SIGKILL (default 300000 = 5min)" },
        },
        required: ["command"],
      },
    },
    {
      name: "ashlr__bash_tail",
      description:
        "Read new stdout/stderr since the last poll for a background session. Auto-compresses the tail window when > 2KB. If wait_ms > 0, blocks (event-driven) until output arrives or the process exits, up to that ceiling.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Session id from ashlr__bash_start" },
          max_bytes: { type: "number", description: "Tail window size (default 2048)" },
          wait_ms: { type: "number", description: "Block up to N ms for new output (default 1500; 0 = return immediately)" },
        },
        required: ["id"],
      },
    },
    {
      name: "ashlr__bash_stop",
      description:
        "Kill a background session by id. Sends SIGTERM (configurable) and escalates to SIGKILL after 2s if still alive.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          signal: { type: "string", description: "Default SIGTERM; escalates to SIGKILL after 2s" },
        },
        required: ["id"],
      },
    },
    {
      name: "ashlr__bash_list",
      description: "List active background sessions: id | pid | started | cumulative bytes | command.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__bash") {
      const text = await ashlrBash(args as unknown as BashArgs);
      return { content: [{ type: "text", text }] };
    }
    if (name === "ashlr__bash_start") {
      const text = await ashlrBashStart(args as unknown as StartArgs);
      return { content: [{ type: "text", text }] };
    }
    if (name === "ashlr__bash_tail") {
      const text = await ashlrBashTail(args as unknown as TailArgs);
      return { content: [{ type: "text", text }] };
    }
    if (name === "ashlr__bash_stop") {
      const text = await ashlrBashStop(args as unknown as StopArgs);
      return { content: [{ type: "text", text }] };
    }
    if (name === "ashlr__bash_list") {
      const text = await ashlrBashList();
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr__bash error: ${message}` }], isError: true };
  }
});

await reloadSessions();

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
