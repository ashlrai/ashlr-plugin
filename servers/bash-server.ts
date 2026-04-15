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
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Savings tracker (shared schema with efficiency server)
// ---------------------------------------------------------------------------

interface Stats {
  session: { calls: number; tokensSaved: number };
  lifetime: { calls: number; tokensSaved: number };
}

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");
const session: Stats["session"] = { calls: 0, tokensSaved: 0 };

async function loadLifetime(): Promise<Stats["lifetime"]> {
  if (!existsSync(STATS_PATH)) return { calls: 0, tokensSaved: 0 };
  try {
    const raw = JSON.parse(await readFile(STATS_PATH, "utf-8")) as Stats;
    return raw.lifetime ?? { calls: 0, tokensSaved: 0 };
  } catch {
    return { calls: 0, tokensSaved: 0 };
  }
}

async function persistStats(lifetime: Stats["lifetime"]): Promise<void> {
  await mkdir(dirname(STATS_PATH), { recursive: true });
  // Preserve any pre-existing session counters from sibling servers when we
  // can — but keeping this server's own session counter as the source of
  // truth is fine because the status line reads lifetime primarily.
  const payload: Stats = { session, lifetime };
  await writeFile(STATS_PATH, JSON.stringify(payload, null, 2));
}

async function recordSaving(rawBytes: number, compactBytes: number): Promise<number> {
  const saved = Math.max(0, Math.ceil((rawBytes - compactBytes) / 4));
  session.calls++;
  session.tokensSaved += saved;
  const lifetime = await loadLifetime();
  lifetime.calls++;
  lifetime.tokensSaved += saved;
  await persistStats(lifetime);
  return saved;
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

function snipBytes(s: string): { out: string; saved: number } {
  if (s.length <= COMPRESS_THRESHOLD) return { out: s, saved: 0 };
  const elided = s.length - HEAD_BYTES - TAIL_BYTES;
  const out =
    s.slice(0, HEAD_BYTES) +
    `\n[... ${elided.toLocaleString()} bytes of output elided ...]\n` +
    s.slice(-TAIL_BYTES);
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

function summarizeGitStatus(stdout: string, branchHint?: string): string {
  // Works with `git status --porcelain` and `git status --porcelain=v1`.
  // Falls through cleanly for empty output.
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    const key = code === "" ? "?" : code;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [k, v] of [...counts.entries()].sort()) {
    parts.push(`${k}: ${v}`);
  }
  const branch = branchHint ? ` · branch ${branchHint}` : "";
  return parts.length === 0
    ? `clean${branch}`
    : `${parts.join(", ")}${branch}`;
}

function summarizeLs(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 40) return null;
  const head = lines.slice(0, 20).join("\n");
  const tail = lines.slice(-10).join("\n");
  return `${head}\n[... ${lines.length - 30} more entries elided ...]\n${tail}\n· ${lines.length} entries total`;
}

function summarizeFind(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 100) return null;
  const head = lines.slice(0, 50).join("\n");
  return `${head}\n[... ${lines.length - 50} more matches elided ...]\n· ${lines.length} matches total`;
}

function summarizePs(stdout: string, cwd: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 100) return null;
  const cwdName = basename(cwd);
  // Always keep the header (line 0).
  const header = lines[0]!;
  const filtered = lines.slice(1).filter((l) => cwdName && l.includes(cwdName));
  if (filtered.length > 0 && filtered.length < lines.length - 1) {
    return `${header}\n${filtered.join("\n")}\n· filtered ${filtered.length} of ${lines.length - 1} processes by cwd name '${cwdName}'`;
  }
  // No cwd-name match — fall back to head/tail.
  return null;
}

function summarizeNpmLs(stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.length < 50) return null;
  // Dedupe duplicate-version warning lines.
  const seenWarn = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const w = line.match(/(deduped|UNMET|invalid)/);
    if (w) {
      const sig = line.trim();
      if (seenWarn.has(sig)) continue;
      seenWarn.add(sig);
    }
    // Collapse depth > 2 by counting indent (pipes/spaces).
    const depth = (line.match(/[│├└]\s/g) ?? []).length;
    if (depth > 2) continue;
    kept.push(line);
  }
  if (kept.length >= lines.length) return null;
  return `${kept.join("\n")}\n· collapsed depth>2 and deduped warnings (${lines.length} → ${kept.length} lines)`;
}

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
    // Use the user's $SHELL when available; fall back to /bin/sh. -c is
    // portable across bash/zsh and preserves quoting/expansion semantics
    // the agent would expect from a normal shell prompt.
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
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

interface BashArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  compact?: boolean;
}

async function ashlrBash(args: BashArgs): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    return "ashlr__bash error: 'command' is required";
  }
  const cwd = args.cwd ?? process.cwd();
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

  if (compact) {
    const structured = await tryStructuredSummary(command, res.stdout, cwd);
    if (structured !== null) {
      body = structured;
      compactBytes = body.length;
    } else {
      const { out, saved } = snipBytes(res.stdout);
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
  return `$ ${command}\n${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${stderrBlock}${stderrBlock.endsWith("\n") ? "" : "\n"}${trailer}`;
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
const SESSIONS_PATH = join(homedir(), ".ashlr", "bash-sessions.json");
const MAX_SESSIONS = 16;
const MAX_CUMULATIVE_BYTES = 50 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 300_000;

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

interface StartArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

async function ashlrBashStart(args: StartArgs): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    return "ashlr__bash_start error: 'command' is required";
  }
  const cwd = args.cwd ?? process.cwd();
  const timeoutMs = args.timeout_ms ?? DEFAULT_START_TIMEOUT_MS;

  const refusal = refusalReason(command);
  if (refusal) return `[refused] ${refusal}`;

  gcOldestInactive();

  const id = newId();
  const shell = process.env.SHELL || "/bin/sh";
  const child = spawn(shell, ["-c", command], {
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

interface TailArgs {
  id: string;
  max_bytes?: number;
  wait_ms?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ashlrBashTail(args: TailArgs): Promise<string> {
  const id = args.id;
  const maxBytes = args.max_bytes ?? 2048;
  const waitMs = args.wait_ms ?? 1500;

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

interface StopArgs {
  id: string;
  signal?: string;
}

async function ashlrBashStop(args: StopArgs): Promise<string> {
  const id = args.id;
  const signal = (args.signal ?? "SIGTERM") as NodeJS.Signals;
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

async function ashlrBashList(): Promise<string> {
  if (SESSIONS.size === 0) return "[list] no active sessions";
  const rows: string[] = [
    "id       | pid     | started           | bytes     | command",
    "---------+---------+-------------------+-----------+--------",
  ];
  for (const s of SESSIONS.values()) {
    const started = new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19);
    const cmd = s.command.length > 40 ? s.command.slice(0, 37) + "..." : s.command;
    rows.push(
      `${s.id.padEnd(8)} | ${String(s.pid).padEnd(7)} | ${started} | ${String(s.cumulativeBytes).padEnd(9)} | ${cmd}`,
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

const transport = new StdioServerTransport();
await server.connect(transport);
