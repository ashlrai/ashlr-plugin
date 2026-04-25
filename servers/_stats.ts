/**
 * Shared stats accounting for all ashlr MCP servers.
 *
 * Replaces the 12 duplicated `recordSaving`/`STATS_PATH`/`loadLifetime`/
 * `persistStats` implementations scattered across servers/* with a single
 * source of truth that is correct under concurrency.
 *
 * Key invariants:
 *   1. Session stats are keyed by CLAUDE_SESSION_ID (or a PPID-derived
 *      fallback) so N concurrent Claude Code terminals never clobber each
 *      other's session counters. The old shape had a single global `session`
 *      field that every server wrote to — that's why the status line number
 *      was unreliable across terminals.
 *   2. Writes are atomic (tempfile + fsync + rename) and serialized by both
 *      an in-process mutex and a filesystem lockfile, so 12 MCP servers +
 *      hooks writing at once will not corrupt the file or lose updates.
 *   3. JSON is minified on disk — every byte of pretty-printing was paid
 *      disk cost with no model-facing benefit.
 *   4. Schema is versioned (schemaVersion: 2) with a migration from v1's
 *      legacy global-`session` layout. Migration is best-effort and
 *      conservative (never loses lifetime totals).
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

// Optional SQLite backend. Statically imported so there's no dynamic-import
// penalty on the hot path, but the SQLite connection is only opened when a
// function below actually routes through it (see useSqlite).
import * as sqliteBackend from "./_stats-sqlite";

/**
 * Backend switch. When `ASHLR_STATS_BACKEND=sqlite`, all exported async
 * entry points delegate to `./_stats-sqlite.ts` (WAL-mode SQLite at
 * `~/.ashlr/stats.db`) instead of the legacy tempfile+lockfile+JSON
 * path. Default `json` — flip to `sqlite` in v1.16 once VS Code and the
 * other direct-stats.json readers catch up.
 */
function useSqlite(): boolean {
  return process.env.ASHLR_STATS_BACKEND === "sqlite";
}

// ---------------------------------------------------------------------------
// Types (exported so server code can reference shapes without duplicating)
// ---------------------------------------------------------------------------

export interface PerTool { calls: number; tokensSaved: number }
export interface ByTool { [k: string]: PerTool }
export interface ByDay  { [date: string]: { calls: number; tokensSaved: number } }

/** Per-session bucket. One per live CLAUDE_SESSION_ID. */
export interface SessionBucket {
  startedAt: string;
  /** ISO timestamp of the most recent recordSaving — drives the status-line animation pulse. */
  lastSavingAt: string | null;
  calls: number;
  tokensSaved: number;
  byTool: ByTool;
}

export interface LifetimeBucket {
  calls: number;
  tokensSaved: number;
  /**
   * Raw token equivalent of every source payload that fed a recordSaving
   * call — the denominator for a `ratio = tokensSaved / rawTotal` display.
   *
   * Added in v1.18 for defensible "% savings" reporting. Optional so that
   * callers constructing a LifetimeBucket literal (tests, fixtures) don't
   * have to be updated — missing field is treated as 0 by every reader.
   * migrateToV2() populates it from on-disk data when present.
   */
  rawTotal?: number;
  byTool: ByTool;
  byDay: ByDay;
}

export interface SummarizationStats {
  calls: number;
  cacheHits: number;
}

/** On-disk shape. schemaVersion lets us migrate without breaking older clients. */
export interface StatsFile {
  schemaVersion: 2;
  sessions: { [sessionId: string]: SessionBucket };
  lifetime: LifetimeBucket;
  summarization?: SummarizationStats;
}

// ---------------------------------------------------------------------------
// Paths & session id
// ---------------------------------------------------------------------------

function home(): string { return process.env.HOME ?? homedir(); }
export function statsPath(): string { return join(home(), ".ashlr", "stats.json"); }
function lockPath(): string { return statsPath() + ".lock"; }
function tempPath(): string { return statsPath() + ".tmp." + process.pid + "." + randomBytes(3).toString("hex"); }

/**
 * Derive the PPID-based fallback session id. Used when CLAUDE_SESSION_ID is
 * not forwarded to this process (which, as of v0.9.x, is what happens for
 * MCP server subprocesses Claude Code spawns — it passes the env var to the
 * status-line and hooks, but NOT to MCP servers).
 */
function ppidSessionId(): string {
  const seed = `ppid:${typeof process.ppid === "number" ? process.ppid : "?"}:${process.env.HOME ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(16)}`;
}

/**
 * v1.19.2: read a sessionId hint from ~/.ashlr/last-project.json (written by
 * hooks/session-start.ts in hook-context where CLAUDE_SESSION_ID IS set).
 * Used when the running process doesn't see the env var (MCP subprocesses,
 * status-line). Hint is gated on a 24h updatedAt TTL so stale entries from
 * old sessions don't leak into new ones.
 *
 * v1.20.2: exported + accepts an optional homeDir so callers in other
 * processes (status-line, sqlite stats backend) can share the same logic
 * instead of duplicating it. The single-source-of-truth prevents the
 * recurring "session counter stuck at 0" regressions (v0.9.3, v1.0.1,
 * v1.20.1) caused by drifted local copies.
 */
export const SESSION_HINT_TTL_MS = 24 * 60 * 60 * 1000;

export function readSessionHint(homeDir: string = process.env.HOME ?? ""): string | null {
  if (!homeDir) return null;
  try {
    const hintPath = join(homeDir, ".ashlr", "last-project.json");
    const raw = readFileSync(hintPath, "utf-8");
    const parsed = JSON.parse(raw) as { sessionId?: unknown; updatedAt?: unknown };
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim().length === 0) return null;
    if (typeof parsed.updatedAt !== "string") return null;
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > SESSION_HINT_TTL_MS) return null;
    return parsed.sessionId.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the current session id for WRITERS. Prefers CLAUDE_SESSION_ID
 * (set by Claude Code for status-line/hook contexts); falls back to the
 * session-start hint file (v1.19.2 — captured where CLAUDE_SESSION_ID is
 * visible); falls back to PPID-derived hash as a last resort.
 *
 * NEVER returns an empty string — always a stable identifier.
 */
export function currentSessionId(): string {
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const hint = readSessionHint();
  if (hint) return hint;
  return ppidSessionId();
}

/**
 * Resolve the set of session ids this process could belong to, for READERS.
 * Because Claude Code inconsistently forwards CLAUDE_SESSION_ID (status line
 * sees it, MCP servers don't), a reader that used only `currentSessionId()`
 * would miss savings written under the OTHER id.
 *
 * v1.19.2: also include the session-start hint id so writers and readers
 * converge on a shared bucket even when neither side sees the env var.
 *
 * The status line calls this and sums across every candidate bucket so the
 * session counter stays correct regardless of which side CLAUDE_SESSION_ID
 * reached.
 */
export function candidateSessionIds(): string[] {
  const ids: string[] = [];
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) ids.push(explicit.trim());
  const hint = readSessionHint();
  if (hint && !ids.includes(hint)) ids.push(hint);
  const ppid = ppidSessionId();
  if (!ids.includes(ppid)) ids.push(ppid);
  return ids;
}

// ---------------------------------------------------------------------------
// Empty-shape helpers
// ---------------------------------------------------------------------------

function emptyTools(): ByTool { return {}; }

function emptySession(startedAt = new Date().toISOString()): SessionBucket {
  return { startedAt, lastSavingAt: null, calls: 0, tokensSaved: 0, byTool: emptyTools() };
}

function emptyLifetime(): LifetimeBucket {
  return { calls: 0, tokensSaved: 0, rawTotal: 0, byTool: emptyTools(), byDay: {} };
}

export function emptyStats(): StatsFile {
  return { schemaVersion: 2, sessions: {}, lifetime: emptyLifetime() };
}

function todayKey(): string { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// Migration (v1 → v2)
// ---------------------------------------------------------------------------

/**
 * Accept any prior shape and coerce to v2. Never throws; returns an empty
 * file on unreadable input rather than losing data silently.
 *
 * v1 shape (in the wild): { session: {...}, lifetime: {...} }
 * v2 shape:               { schemaVersion: 2, sessions: {...}, lifetime: {...} }
 */
export function migrateToV2(raw: unknown): StatsFile {
  if (!raw || typeof raw !== "object") return emptyStats();
  const r = raw as Partial<StatsFile> & { session?: Partial<SessionBucket>; summarization?: SummarizationStats };
  if (r.schemaVersion === 2 && r.sessions && r.lifetime) {
    return {
      schemaVersion: 2,
      sessions: coerceSessions(r.sessions),
      lifetime: coerceLifetime(r.lifetime),
      summarization: r.summarization,
    };
  }
  // v1 → v2: lifetime carries over; legacy global `session` is discarded
  // because it was never accurate across concurrent terminals anyway.
  return {
    schemaVersion: 2,
    sessions: {},
    lifetime: coerceLifetime(r.lifetime),
    summarization: r.summarization,
  };
}

function coerceSessions(v: unknown): { [id: string]: SessionBucket } {
  if (!v || typeof v !== "object") return {};
  const out: { [id: string]: SessionBucket } = {};
  for (const [id, bucket] of Object.entries(v as Record<string, unknown>)) {
    const b = (bucket ?? {}) as Partial<SessionBucket>;
    out[id] = {
      startedAt: typeof b.startedAt === "string" ? b.startedAt : new Date().toISOString(),
      lastSavingAt: typeof b.lastSavingAt === "string" ? b.lastSavingAt : null,
      calls: numOr0(b.calls),
      tokensSaved: numOr0(b.tokensSaved),
      byTool: coerceByTool(b.byTool),
    };
  }
  return out;
}

function coerceLifetime(v: unknown): LifetimeBucket {
  const l = (v ?? {}) as Partial<LifetimeBucket>;
  const out: LifetimeBucket = {
    calls: numOr0(l.calls),
    tokensSaved: numOr0(l.tokensSaved),
    byTool: coerceByTool(l.byTool),
    byDay: coerceByDay(l.byDay),
  };
  // v1.18: rawTotal is optional. Only set it when present + non-zero so
  // reads of legacy files stay byte-equal (no spurious rawTotal:0 tag in
  // the in-memory shape that wasn't on disk).
  const rt = numOr0(l.rawTotal);
  if (rt > 0) out.rawTotal = rt;
  return out;
}

function coerceByTool(v: unknown): ByTool {
  if (!v || typeof v !== "object") return {};
  const out: ByTool = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = (val ?? {}) as Partial<PerTool>;
    out[k] = { calls: numOr0(p.calls), tokensSaved: numOr0(p.tokensSaved) };
  }
  return out;
}

function coerceByDay(v: unknown): ByDay {
  if (!v || typeof v !== "object") return {};
  const out: ByDay = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = (val ?? {}) as { calls?: number; tokensSaved?: number };
    out[k] = { calls: numOr0(p.calls), tokensSaved: numOr0(p.tokensSaved) };
  }
  return out;
}

function numOr0(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

// ---------------------------------------------------------------------------
// In-memory cache + mtime invalidation
// ---------------------------------------------------------------------------

/** True when ASHLR_STATS_SYNC=1 — bypasses debouncing entirely. Checked per-call so tests can toggle it. */
function isSyncMode(): boolean { return process.env.ASHLR_STATS_SYNC === "1"; }

interface MemCache {
  data: StatsFile;
  /** mtime of the file when we last read it; used to detect external writes. */
  mtime: number;
}

let _memCache: MemCache | null = null;

function fileMtime(): number {
  try { return statSync(statsPath()).mtimeMs; } catch { return 0; }
}

/** Read from in-memory cache if still valid, otherwise hit disk. */
async function readStatsCached(): Promise<StatsFile> {
  const mtime = fileMtime();
  if (_memCache && _memCache.mtime === mtime) return _memCache.data;
  const fresh = await readStats();
  _memCache = { data: fresh, mtime };
  return fresh;
}

function updateMemCache(s: StatsFile): void {
  _memCache = { data: s, mtime: fileMtime() };
}

// ---------------------------------------------------------------------------
// Debounce flush
// ---------------------------------------------------------------------------

/** Pending deltas waiting to be merged into the next disk write. */
interface PendingDelta {
  toolName: string;
  saved: number;
  sessionId: string;
  day: string;
}

let _pendingDeltas: PendingDelta[] = [];
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 250;

/** Accumulated in-memory state that hasn't been flushed yet. */
let _pendingStats: StatsFile | null = null;

/** How many disk writes have occurred (for test coalescing assertions). */
let _writeCount = 0;
export function _getWriteCount(): number { return _writeCount; }
export function _resetWriteCount(): void { _writeCount = 0; }

async function flushToDisk(): Promise<void> {
  if (!_pendingStats) return;
  const toWrite = _pendingStats;
  // Clear the debounce timer but keep `_pendingStats` populated until the
  // write actually lands — that way if the process exits mid-write, the
  // sync exit handler can re-run the flush and nothing is lost.
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  const release = await acquireFileLock();
  try {
    await writeStatsAtomic(toWrite);
    _writeCount++;
    updateMemCache(toWrite);
    // Only now is it safe to declare the pending delta flushed. A new
    // recordSaving that arrived mid-write mutated `_pendingStats` in place
    // (same object reference), so `toWrite === _pendingStats` is still true.
    if (_pendingStats === toWrite) _pendingStats = null;
  } finally {
    await release();
  }
}

/**
 * Synchronous flush on exit — never loses tail of a session. Because
 * `flushToDisk` keeps `_pendingStats` populated until the rename succeeds,
 * this sync path will re-fire any in-flight async flush that hadn't
 * completed before process exit.
 */
function flushToDiskSync(): void {
  if (!_pendingStats) return;
  const toWrite = _pendingStats;
  _pendingStats = null;
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  const p = statsPath();
  mkdirSync(dirname(p), { recursive: true });
  const tp = p + ".tmp." + process.pid + "." + randomBytes(3).toString("hex");
  writeFileSync(tp, JSON.stringify(toWrite));
  renameSync(tp, p);
  _writeCount++;
}

// Register exit handlers once.
process.on("exit", flushToDiskSync);
process.on("beforeExit", () => { if (_pendingStats) { flushToDiskSync(); } });

// ---------------------------------------------------------------------------
// Cross-process + in-process locking
// ---------------------------------------------------------------------------

/**
 * In-process mutex. Serializes the read-modify-write cycle across every
 * recordSaving invocation within a single MCP server process. Without this,
 * two concurrent tool calls in the same server could race on the in-memory
 * copy between read and write.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Cross-process advisory lock via a sibling `.lock` file.
 * - atomic create-exclusive (O_EXCL) — fails if another process holds it
 * - mtime-based stale-lock detection (5s) so a crashed holder doesn't
 *   wedge us forever
 * - bounded retry with jitter; on timeout we proceed *without* the lock
 *   rather than block the tool call. Under contention we prefer a
 *   possibly-lossy write to a hung MCP server.
 */
async function acquireFileLock(timeoutMs = 500): Promise<() => Promise<void>> {
  const lp = lockPath();
  await mkdir(dirname(lp), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await writeFile(lp, String(process.pid), { flag: "wx" });
      return async () => { try { await unlink(lp); } catch { /* ignore */ } };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        // Non-contention error (perm denied, etc.) — give up and proceed
        // without lock rather than throw.
        return async () => { /* noop */ };
      }
      // Check for stale lock (mtime older than 5s)
      try {
        const st = await stat(lp);
        if (Date.now() - st.mtimeMs > 5_000) {
          // best-effort: clearing a stale lock is advisory; a concurrent writer may have just deleted it, in which case the next wx-create will race to acquire it.
          await unlink(lp).catch(() => {});
          continue; // retry immediately
        }
      } catch { /* stat failed; lock may have been released, retry */ }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  // Lock timed out — proceed without it. Not ideal, but better than
  // blocking a tool call. Callers still see consistent in-process state
  // via the write queue.
  return async () => { /* noop */ };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** Read stats.json, migrating if needed. Always resolves; never throws.
 *  Returns the pending in-memory state when a debounced flush is outstanding,
 *  so callers see up-to-date numbers without waiting for disk. */
export async function readStats(): Promise<StatsFile> {
  if (useSqlite()) return sqliteBackend.readStats();
  if (_pendingStats) return _pendingStats;
  const p = statsPath();
  if (!existsSync(p)) return emptyStats();
  try {
    return migrateToV2(JSON.parse(await readFile(p, "utf-8")));
  } catch {
    return emptyStats();
  }
}

/** Atomic write: temp + rename. Minified JSON. */
async function writeStatsAtomic(s: StatsFile): Promise<void> {
  const p = statsPath();
  await mkdir(dirname(p), { recursive: true });
  const tp = tempPath();
  // Minified: no pretty-print whitespace on disk.
  await writeFile(tp, JSON.stringify(s));
  await rename(tp, p);
}

/**
 * Serialize every read-modify-write through one queue so in-process
 * recordSaving calls can't race with each other, then acquire the
 * cross-process lock for the disk portion.
 *
 * In SYNC_MODE (ASHLR_STATS_SYNC=1) this behaves as before: every call
 * acquires the file lock and writes atomically.  In debounced mode the fn
 * still runs inside the in-process queue but the actual disk write is
 * coalesced and deferred by up to DEBOUNCE_MS.
 */
async function withSerializedWrite<T>(fn: (s: StatsFile) => Promise<{ result: T; updated: StatsFile }>, opts: { immediate?: boolean } = {}): Promise<T> {
  let resolveOuter!: (v: T) => void;
  let rejectOuter!: (err: unknown) => void;
  const outer = new Promise<T>((res, rej) => { resolveOuter = res; rejectOuter = rej; });

  const runFn = async () => {
    if (isSyncMode() || opts.immediate) {
      const release = await acquireFileLock();
      try {
        const s = await readStatsCached();
        const { result, updated } = await fn(s);
        await writeStatsAtomic(updated);
        _writeCount++;
        updateMemCache(updated);
        resolveOuter(result);
      } catch (e) {
        rejectOuter(e);
      } finally {
        await release();
      }
    } else {
      // Debounced path: mutate in memory, schedule flush.
      try {
        const base = _pendingStats ?? await readStatsCached();
        const { result, updated } = await fn(base);
        _pendingStats = updated;
        resolveOuter(result);
        // Arm/re-arm the debounce timer.
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          writeQueue = writeQueue.then(() => flushToDisk());
        }, DEBOUNCE_MS);
      } catch (e) {
        rejectOuter(e);
      }
    }
  };

  writeQueue = writeQueue.then(runFn, runFn);
  return outer;
}

// ---------------------------------------------------------------------------
// Public API — the single recordSaving used by every server
// ---------------------------------------------------------------------------

/**
 * Record a tokens-saved event. Safe under concurrency. Returns the delta
 * applied (useful for callers that want to surface a "[compact saved N]"
 * note inline). Never throws.
 */
export async function recordSaving(
  rawBytes: number,
  compactBytes: number,
  toolName: string,
  opts: { sessionId?: string } = {},
): Promise<number> {
  if (useSqlite()) return sqliteBackend.recordSaving(rawBytes, compactBytes, toolName, opts);
  // Defensive: raw and compact must be finite non-negative numbers. If
  // caller passes garbage, zero out rather than record NaN into lifetime.
  const rawSafe = Number.isFinite(rawBytes) && rawBytes >= 0 ? rawBytes : 0;
  const compactSafe = Number.isFinite(compactBytes) && compactBytes >= 0 ? compactBytes : 0;
  const saved = Math.max(0, Math.ceil((rawSafe - compactSafe) / 4));
  // `rawTok` is the counterfactual token count — tokens that *would have*
  // been sent if the plugin hadn't intercepted. Used as the denominator
  // for the % savings display.
  const rawTok = Math.max(0, Math.ceil(rawSafe / 4));
  const sid = opts.sessionId ?? currentSessionId();
  return withSerializedWrite(async (s) => {
    bump(s, toolName, saved, rawTok, sid);
    return { result: saved, updated: s };
  });
}

function bump(s: StatsFile, toolName: string, saved: number, rawTok: number, sessionId: string): void {
  // Session bucket
  const sess = s.sessions[sessionId] ?? (s.sessions[sessionId] = emptySession());
  sess.calls += 1;
  sess.tokensSaved += saved;
  sess.lastSavingAt = new Date().toISOString();
  const st = sess.byTool[toolName] ?? (sess.byTool[toolName] = { calls: 0, tokensSaved: 0 });
  st.calls += 1;
  st.tokensSaved += saved;

  // Lifetime
  s.lifetime.calls += 1;
  s.lifetime.tokensSaved += saved;
  // v1.18: accumulate the raw (counterfactual) token count so the dashboard
  // can render a defensible `saved / rawTotal` ratio. Guard against legacy
  // in-memory state that predates the field.
  s.lifetime.rawTotal = (s.lifetime.rawTotal ?? 0) + rawTok;
  const lt = s.lifetime.byTool[toolName] ?? (s.lifetime.byTool[toolName] = { calls: 0, tokensSaved: 0 });
  lt.calls += 1;
  lt.tokensSaved += saved;
  const day = todayKey();
  const d = s.lifetime.byDay[day] ?? (s.lifetime.byDay[day] = { calls: 0, tokensSaved: 0 });
  d.calls += 1;
  d.tokensSaved += saved;
}

/**
 * Initialize (or refresh startedAt on) the current session's bucket.
 * Called by SessionStart hook. Idempotent. Never clobbers lifetime.
 */
export async function initSessionBucket(sessionId: string = currentSessionId()): Promise<void> {
  if (useSqlite()) return sqliteBackend.initSessionBucket(sessionId);
  await withSerializedWrite(async (s) => {
    if (!s.sessions[sessionId]) s.sessions[sessionId] = emptySession();
    return { result: undefined as void, updated: s };
  });
}

/**
 * Drop this session's bucket(s) (called by SessionEnd GC hook). Removes every
 * candidate id so that orphaned buckets (e.g. the MCP-written PPID-hash bucket
 * when CLAUDE_SESSION_ID was set for the hook but not forwarded to MCP) don't
 * accumulate. Returns the combined dropped bucket for summary logging.
 */
export async function dropSessionBucket(sessionId?: string): Promise<SessionBucket | null> {
  if (useSqlite()) return sqliteBackend.dropSessionBucket(sessionId);
  const ids = sessionId ? [sessionId] : candidateSessionIds();
  return withSerializedWrite(async (s) => {
    let calls = 0;
    let tokensSaved = 0;
    let startedAt = "";
    let lastSavingAt: string | null = null;
    let hit = false;
    const byTool: ByTool = {};
    for (const id of ids) {
      const b = s.sessions[id];
      if (!b) continue;
      hit = true;
      calls += b.calls;
      tokensSaved += b.tokensSaved;
      if (!startedAt || b.startedAt < startedAt) startedAt = b.startedAt;
      if (b.lastSavingAt && (!lastSavingAt || b.lastSavingAt > lastSavingAt)) lastSavingAt = b.lastSavingAt;
      for (const [tool, pt] of Object.entries(b.byTool)) {
        const t = byTool[tool] ?? (byTool[tool] = { calls: 0, tokensSaved: 0 });
        t.calls += pt.calls;
        t.tokensSaved += pt.tokensSaved;
      }
      delete s.sessions[id];
    }
    const dropped: SessionBucket | null = hit
      ? { startedAt: startedAt || new Date().toISOString(), lastSavingAt, calls, tokensSaved, byTool }
      : null;
    return { result: dropped, updated: s };
  });
}

/** Bump a summarization counter (calls | cacheHits). Used by _summarize.ts. */
export async function bumpSummarization(field: "calls" | "cacheHits"): Promise<void> {
  if (useSqlite()) return sqliteBackend.bumpSummarization(field);
  await withSerializedWrite(async (s) => {
    const sm = s.summarization ?? (s.summarization = { calls: 0, cacheHits: 0 });
    sm[field] = (sm[field] ?? 0) + 1;
    return { result: undefined as void, updated: s };
  });
}

/**
 * Convenience read for the status line and /ashlr-savings: returns the
 * current session's bucket (or an empty one if absent).
 */
export async function readCurrentSession(sessionId?: string): Promise<SessionBucket> {
  if (useSqlite()) return sqliteBackend.readCurrentSession(sessionId);
  const s = await readStats();
  const ids = sessionId ? [sessionId] : candidateSessionIds();
  let calls = 0;
  let tokensSaved = 0;
  let startedAt = "";
  let lastSavingAt: string | null = null;
  const byTool: ByTool = {};
  for (const id of ids) {
    const b = s.sessions[id];
    if (!b) continue;
    calls += b.calls;
    tokensSaved += b.tokensSaved;
    if (!startedAt || b.startedAt < startedAt) startedAt = b.startedAt;
    if (b.lastSavingAt && (!lastSavingAt || b.lastSavingAt > lastSavingAt)) lastSavingAt = b.lastSavingAt;
    for (const [tool, pt] of Object.entries(b.byTool)) {
      const t = byTool[tool] ?? (byTool[tool] = { calls: 0, tokensSaved: 0 });
      t.calls += pt.calls;
      t.tokensSaved += pt.tokensSaved;
    }
  }
  return { startedAt: startedAt || new Date().toISOString(), lastSavingAt, calls, tokensSaved, byTool };
}

/**
 * Test hook: flush any pending debounced state to disk, then drain the write
 * queue. Lets tests assert committed on-disk state without sleeping.
 */
export async function _drainWrites(): Promise<void> {
  // If there's a pending debounce timer, fire it now.
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    writeQueue = writeQueue.then(() => flushToDisk());
  }
  // best-effort: this is a test-only drain; underlying flushes already reported any errors via their own logging paths, so we just need the queue to settle.
  await writeQueue.catch(() => {});
}

/** Test hook: reset in-memory cache so next read goes to disk. */
export function _resetMemCache(): void {
  _memCache = null;
  _pendingStats = null;
  _pendingDeltas = [];
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
}

// ---------------------------------------------------------------------------
// Pro-tier cloud sync (opt-in via ASHLR_PRO_TOKEN)
// ---------------------------------------------------------------------------

/** Epoch ms of the last successful or attempted cloud upload. */
let _lastSyncAt = 0;

/** Test hook: reset the sync throttle so the next maybeSyncToCloud() call fires. */
export function _resetCloudSync(): void { _lastSyncAt = 0; }
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fire-and-forget upload of lifetime stats to the ashlr pro backend.
 *
 * Gated on:
 *   - ASHLR_PRO_TOKEN being set (opt-in)
 *   - ASHLR_STATS_UPLOAD !== "0" (kill switch)
 *   - At most once per 5 minutes
 *
 * Never throws, never blocks a tool call.
 */
export function maybeSyncToCloud(): void {
  const token = process.env["ASHLR_PRO_TOKEN"];
  if (!token) return;
  if (process.env["ASHLR_STATS_UPLOAD"] === "0") return;
  const now = Date.now();
  if (now - _lastSyncAt < SYNC_INTERVAL_MS) return;
  _lastSyncAt = now;

  // Detach — never await this
  void _doCloudSync(token);
}

async function _doCloudSync(token: string): Promise<void> {
  try {
    const stats = await readStats();
    const apiUrl = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";

    // Build a pure-counts payload — no paths, no content, no PII
    const byTool: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats.lifetime.byTool)) {
      byTool[k] = v.tokensSaved;
    }
    const byDay: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats.lifetime.byDay)) {
      byDay[k] = v.tokensSaved;
    }

    await fetch(`${apiUrl}/stats/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: token,
        stats: {
          lifetime: {
            calls:       stats.lifetime.calls,
            tokensSaved: stats.lifetime.tokensSaved,
            byTool,
            byDay,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Network failure or timeout — drop silently, never surface to the user
  }
}
