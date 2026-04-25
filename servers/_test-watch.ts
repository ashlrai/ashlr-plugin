/**
 * _test-watch — background test-watch session manager for `ashlr__test`.
 *
 * Companion to the `ashlr__bash_start`/`bash_tail`/`bash_stop`/`bash_list`
 * primitives. A test-watch session:
 *
 *   1. Spawns the detected runner (bun/vitest/jest/pytest/go) once on entry.
 *   2. Watches the session cwd for .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go file
 *      changes (via `fs.watch` recursive, with a poll fallback when the
 *      platform rejects `{ recursive: true }`).
 *   3. Debounces rapid change bursts (200ms) so a multi-file save doesn't
 *      thrash the runner.
 *   4. Reruns the same command+args on each settled change.
 *   5. Lives until explicitly stopped (via `stopTestWatch` / `ashlr__bash_stop`)
 *      or until the parent MCP server exits (`process.on('exit')`).
 *
 * Sessions are registered with the bash-server via `registerExternalSessions`,
 * so `ashlr__bash_list` enumerates both "bash" and "test-watch" sessions from
 * one place. Per-session metadata is persisted to
 * `~/.ashlr/test-watch-sessions/<id>.json` so a doctor can prune stale entries
 * after a crash.
 *
 * Safety caps:
 *   - max 8 concurrent watch sessions per user
 *   - 50 MB stdout cap per session (mirrors bash-server)
 *   - child is spawned with its own process group on POSIX so SIGKILL reaches
 *     grandchildren (vitest workers, bun subprocesses)
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "fs";
import { writeFile, readFile, mkdir, readdir, unlink } from "fs/promises";
import { homedir } from "os";
import { join, sep } from "path";
import { randomBytes } from "crypto";
import { registerExternalSessions, type ExternalSession } from "./bash-server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WATCH_SESSIONS = 8;
const DEBOUNCE_MS = 200;
const MAX_CUMULATIVE_BYTES = 50 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
const WATCH_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go",
]);
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", ".nuxt", ".svelte-kit", "target", "__pycache__",
  ".pytest_cache", ".venv", "venv",
]);

// Prefer $HOME when explicitly set (matches the rest of the ashlr codebase).
const ASHLR_HOME = process.env.HOME ?? homedir();
const WATCH_DIR = join(ASHLR_HOME, ".ashlr", "test-watch-sessions");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestWatchArgs {
  /** Working directory to watch and to spawn tests in. Must be clamped. */
  cwd: string;
  /** Command + args array to run on each change (already resolved). */
  command: string[];
  /** Human-readable label for bash_list ("bun test src/foo.test.ts"). */
  label: string;
  /** Optional grep filter appended to args for re-runs (informational). */
  grep?: string;
}

interface WatchSession {
  id: string;
  pid: number;                 // pid of the CURRENT running child (-1 if idle)
  command: string[];
  label: string;
  cwd: string;
  startedAt: number;
  child: ChildProcess | null;
  stdout: string;
  stderr: string;
  offset: number;
  stderrOffset: number;
  cumulativeBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lastActivity: number;
  lastRunAt: number;
  runCount: number;
  watcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  pollSnapshot: Map<string, number>; // path -> mtimeMs
  debounceTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  dataEmitter: Set<() => void>;
}

interface PersistedWatchSession {
  id: string;
  pid: number;
  command: string[];
  label: string;
  cwd: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

const SESSIONS = new Map<string, WatchSession>();

function newId(): string {
  return randomBytes(4).toString("hex");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function sessionFile(id: string): string {
  return join(WATCH_DIR, `${id}.json`);
}

async function persistSession(s: WatchSession): Promise<void> {
  try {
    await mkdir(WATCH_DIR, { recursive: true });
    const payload: PersistedWatchSession = {
      id: s.id,
      pid: s.pid,
      command: s.command,
      label: s.label,
      cwd: s.cwd,
      startedAt: s.startedAt,
    };
    await writeFile(sessionFile(s.id), JSON.stringify(payload, null, 2));
  } catch {
    /* best-effort — disk full / read-only home shouldn't wedge the runner */
  }
}

async function unpersistSession(id: string): Promise<void> {
  try {
    await unlink(sessionFile(id));
  } catch {
    /* already gone */
  }
}

/**
 * Prune stale JSON files whose pids are no longer alive. Called once at
 * module load; dead files don't count against MAX_WATCH_SESSIONS.
 */
export async function reloadWatchSessions(): Promise<void> {
  if (!existsSync(WATCH_DIR)) return;
  let entries: string[];
  try {
    entries = await readdir(WATCH_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(WATCH_DIR, name);
    try {
      const raw = await readFile(path, "utf-8");
      const p = JSON.parse(raw) as PersistedWatchSession;
      if (!pidAlive(p.pid)) {
        try { await unlink(path); } catch { /* ignore */ }
      }
      // We can't reattach to a process we didn't spawn, so even live pids
      // from a prior run are orphan zombies; drop their files too. They
      // were cleaned up by process.on('exit') in the previous run when the
      // parent died.
    } catch {
      try { await unlink(path); } catch { /* ignore */ }
    }
  }
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

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

function isWatchedFile(path: string): boolean {
  const parts = path.split(sep);
  for (const p of parts) {
    if (IGNORE_DIRS.has(p)) return false;
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot);
  return WATCH_EXTENSIONS.has(ext);
}

function snapshotDir(root: string): Map<string, number> {
  // Walk the tree breadth-first and stat each watched file. Used by the
  // poll-fallback path when fs.watch(recursive) is unavailable.
  const out = new Map<string, number>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (IGNORE_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        queue.push(full);
      } else if (st.isFile() && isWatchedFile(full)) {
        out.set(full, st.mtimeMs);
      }
    }
  }
  return out;
}

function diffSnapshots(prev: Map<string, number>, next: Map<string, number>): boolean {
  if (prev.size !== next.size) return true;
  for (const [k, v] of next) {
    const pv = prev.get(k);
    if (pv === undefined || pv !== v) return true;
  }
  return false;
}

/**
 * Install a watcher on `cwd`. Prefers `fs.watch(cwd, { recursive: true })`
 * (supported on macOS/Windows; Linux requires kernel >= 5.1 for inotify
 * recursive, otherwise throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM). On
 * failure, falls back to a 1-second mtime poll.
 *
 * Returns { watcher, pollTimer }; exactly one is non-null.
 */
function installWatcher(
  session: WatchSession,
  onChange: (path: string) => void,
): { watcher: FSWatcher | null; pollTimer: ReturnType<typeof setInterval> | null; pollSnapshot: Map<string, number> } {
  // Try native recursive watch first.
  try {
    const w = watch(session.cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const fname = typeof filename === "string" ? filename : String(filename);
      const full = join(session.cwd, fname);
      if (!isWatchedFile(full)) return;
      onChange(full);
    });
    // fs.watch emits 'error' on some platforms instead of throwing.
    w.on("error", () => { /* swallow — poll will take over if we respawn */ });
    return { watcher: w, pollTimer: null, pollSnapshot: new Map() };
  } catch {
    // Fallback: poll at 1Hz comparing mtime snapshots.
    const snap = snapshotDir(session.cwd);
    const timer = setInterval(() => {
      const next = snapshotDir(session.cwd);
      if (diffSnapshots(session.pollSnapshot, next)) {
        session.pollSnapshot = next;
        // We don't have a single "changed" path; pass the cwd as a sentinel.
        onChange(session.cwd);
      }
    }, POLL_INTERVAL_MS);
    return { watcher: null, pollTimer: timer, pollSnapshot: snap };
  }
}

// ---------------------------------------------------------------------------
// Child process lifecycle
// ---------------------------------------------------------------------------

function spawnTestRun(session: WatchSession): void {
  if (session.stopped) return;
  // If a prior run is still going, kill it so we don't stack runners.
  if (session.child && session.exitCode === null) {
    killChild(session.child);
  }

  const isWin = process.platform === "win32";
  const [bin, ...args] = session.command;
  const child = spawn(bin, args, {
    cwd: session.cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWin,
      shell: isWin,
  });

  session.child = child;
  session.pid = child.pid ?? -1;
  session.exitCode = null;
  session.signal = null;
  session.lastRunAt = Date.now();
  session.runCount += 1;
  session.lastActivity = Date.now();

  const runHeader = `\n[run #${session.runCount} at ${new Date().toISOString()}] $ ${session.label}\n`;
  session.stdout += runHeader;
  session.cumulativeBytes += runHeader.length;

  child.stdout?.on("data", (b: Buffer) => {
    const s = b.toString("utf-8");
    session.stdout += s;
    session.cumulativeBytes += b.length;
    session.lastActivity = Date.now();
    if (session.cumulativeBytes > MAX_CUMULATIVE_BYTES) {
      session.stderr += `\n[ashlr: test-watch session exceeded ${MAX_CUMULATIVE_BYTES} bytes — killed]\n`;
      stopTestWatchInternal(session);
    }
    for (const fn of [...session.dataEmitter]) fn();
  });
  child.stderr?.on("data", (b: Buffer) => {
    session.stderr += b.toString("utf-8");
    session.lastActivity = Date.now();
    for (const fn of [...session.dataEmitter]) fn();
  });
  child.on("close", (code, signal) => {
    if (session.child === child) {
      session.exitCode = code;
      session.signal = signal;
      session.pid = -1;
      session.child = null;
      session.lastActivity = Date.now();
      const footer = `[run #${session.runCount} → exit ${code ?? "?"}${signal ? ` · ${signal}` : ""}]\n`;
      session.stdout += footer;
      session.cumulativeBytes += footer.length;
      for (const fn of [...session.dataEmitter]) fn();
    }
  });
  child.on("error", (err) => {
    session.stderr += `\n[spawn error: ${err.message}]\n`;
    for (const fn of [...session.dataEmitter]) fn();
  });

  // Update persisted pid so a doctor can reap cleanly.
  void persistSession(session);
}

function killChild(child: ChildProcess): void {
  const isWin = process.platform === "win32";
  if (isWin) {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  } else if (child.pid != null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }
  } else {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartResult {
  ok: true;
  id: string;
  pid: number;
  message: string;
}

export interface StartError {
  ok: false;
  message: string;
}

export function startTestWatch(args: TestWatchArgs): StartResult | StartError {
  // Count only still-alive sessions.
  for (const s of [...SESSIONS.values()]) {
    if (s.stopped) SESSIONS.delete(s.id);
  }
  if (SESSIONS.size >= MAX_WATCH_SESSIONS) {
    return {
      ok: false,
      message:
        `ashlr__test watch: max ${MAX_WATCH_SESSIONS} concurrent watch sessions reached — ` +
        `stop one via ashlr__bash_stop first.`,
    };
  }

  // Ensure the persistence dir exists synchronously so the caller sees
  // the file immediately (tests rely on this).
  try { mkdirSync(WATCH_DIR, { recursive: true }); } catch { /* ignore */ }

  const id = newId();
  const session: WatchSession = {
    id,
    pid: -1,
    command: args.command,
    label: args.label,
    cwd: args.cwd,
    startedAt: Date.now(),
    child: null,
    stdout: "",
    stderr: "",
    offset: 0,
    stderrOffset: 0,
    cumulativeBytes: 0,
    exitCode: null,
    signal: null,
    lastActivity: Date.now(),
    lastRunAt: 0,
    runCount: 0,
    watcher: null,
    pollTimer: null,
    pollSnapshot: new Map(),
    debounceTimer: null,
    stopped: false,
    dataEmitter: new Set(),
  };

  // Install watcher with debounce.
  const onChange = (_path: string) => {
    if (session.stopped) return;
    if (session.debounceTimer) clearTimeout(session.debounceTimer);
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null;
      spawnTestRun(session);
    }, DEBOUNCE_MS);
  };
  const { watcher, pollTimer, pollSnapshot } = installWatcher(session, onChange);
  session.watcher = watcher;
  session.pollTimer = pollTimer;
  session.pollSnapshot = pollSnapshot;

  SESSIONS.set(id, session);

  // Persist synchronously-ish (fire-and-forget; file exists shortly after).
  void persistSession(session);

  // Kick off the initial run.
  spawnTestRun(session);

  return {
    ok: true,
    id,
    pid: session.pid,
    message:
      `[ashlr__test watch] started · id=${id} · watching ${args.cwd} · ` +
      `use ashlr__bash_tail id=${id} to stream output, ashlr__bash_stop id=${id} to stop.`,
  };
}

function stopTestWatchInternal(session: WatchSession): void {
  if (session.stopped) return;
  session.stopped = true;
  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = null;
  }
  if (session.watcher) {
    try { session.watcher.close(); } catch { /* ignore */ }
    session.watcher = null;
  }
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  if (session.child && session.exitCode === null) {
    killChild(session.child);
  }
  SESSIONS.delete(session.id);
  void unpersistSession(session.id);
  for (const fn of [...session.dataEmitter]) fn();
}

export function stopTestWatch(id: string, _signal?: NodeJS.Signals): string | null {
  const s = SESSIONS.get(id);
  if (!s) return null;
  const label = s.label;
  stopTestWatchInternal(s);
  return `[${id}] test-watch stopped · ${label}`;
}

export function getTestWatchSession(id: string): WatchSession | undefined {
  return SESSIONS.get(id);
}

// ---------------------------------------------------------------------------
// Tail adapter — mirrors ashlr__bash_tail's semantics so the same tool works
// ---------------------------------------------------------------------------

export async function tailTestWatch(
  id: string,
  waitMs: number,
  _maxBytes: number,
): Promise<string | null> {
  const s = SESSIONS.get(id);
  if (!s) return null;

  const hasNew = (): boolean =>
    s.stdout.length > s.offset ||
    s.stderr.length > s.stderrOffset ||
    s.stopped;

  if (!hasNew() && waitMs > 0) {
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
      if (hasNew()) finish();
    });
  }

  const newStdout = s.stdout.slice(s.offset);
  const newStderr = s.stderr.slice(s.stderrOffset);
  const newBytes = newStdout.length;
  s.offset = s.stdout.length;
  s.stderrOffset = s.stderr.length;
  s.lastActivity = Date.now();

  const statusLabel = s.stopped
    ? "stopped"
    : s.child
      ? `running (run #${s.runCount})`
      : `idle (last run #${s.runCount} exit ${s.exitCode ?? "?"})`;

  const header = `[${id} · ${statusLabel}] +${newBytes} bytes since last poll`;
  const stderrBlock = newStderr.length > 0 ? `\n--- stderr ---\n${newStderr}` : "";
  const body = newStdout;

  return `${header}\n${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${stderrBlock}`;
}

// ---------------------------------------------------------------------------
// bash-server integration — expose test-watch sessions to ashlr__bash_list
// and to ashlr__bash_stop / ashlr__bash_tail (so one tool surface manages
// both kinds of background work).
// ---------------------------------------------------------------------------

function toExternalSession(s: WatchSession): ExternalSession {
  return {
    id: s.id,
    pid: s.pid > 0 ? s.pid : -1,
    command: `[test-watch] ${s.label}`,
    cwd: s.cwd,
    startedAt: s.startedAt,
    cumulativeBytes: s.cumulativeBytes,
    kind: "test-watch",
  };
}

registerExternalSessions({
  kind: "test-watch",
  list(): ExternalSession[] {
    return [...SESSIONS.values()].map(toExternalSession);
  },
  tail(id, waitMs, maxBytes): Promise<string | null> {
    return tailTestWatch(id, waitMs, maxBytes);
  },
  stop(id, signal): string | null {
    return stopTestWatch(id, signal);
  },
  has(id): boolean {
    return SESSIONS.has(id);
  },
});

// ---------------------------------------------------------------------------
// Parent-exit cleanup — kill every watcher child and clean up JSON files so
// a future run sees a clean slate.
// ---------------------------------------------------------------------------

let exitHandlerInstalled = false;
function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  const cleanup = () => {
    for (const s of [...SESSIONS.values()]) {
      try { stopTestWatchInternal(s); } catch { /* ignore */ }
      try {
        // Synchronous unlink on exit — async won't complete.
        unlinkSync(sessionFile(s.id));
      } catch { /* already gone */ }
      // Also synchronously write a best-effort tombstone so cwd-clamp
      // tests can observe final state.
      try {
        writeFileSync(
          sessionFile(s.id) + ".tombstone",
          JSON.stringify({ id: s.id, exitedAt: Date.now() }),
        );
        unlinkSync(sessionFile(s.id) + ".tombstone");
      } catch { /* ignore */ }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}
installExitHandler();

// Opportunistic prune at module load (best-effort).
void reloadWatchSessions();

// Exposed for tests.
export function __activeWatchSessionsForTests(): number {
  return SESSIONS.size;
}

export function __clearWatchSessionsForTests(): void {
  for (const s of [...SESSIONS.values()]) {
    stopTestWatchInternal(s);
  }
  SESSIONS.clear();
}
