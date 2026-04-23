/**
 * _stats-sqlite.ts — SQLite-backed stats store.
 *
 * Drop-in replacement for the recordSaving / readStats / readCurrentSession
 * surface in _stats.ts, backed by ~/.ashlr/stats.db instead of the
 * tempfile+lockfile+JSON path that has been the source of 6 distinct
 * regressions across v0.9.x → v1.0.x.
 *
 * Why SQLite:
 *   - bun:sqlite is already an accepted dep (see servers/_embedding-cache.ts).
 *   - WAL mode gives us multi-process concurrency for free — N terminals
 *     running the MCP server simultaneously no longer need a userland
 *     lockfile dance or cross-process mutex.
 *   - Each recordSaving becomes ONE transaction that touches 5 rows —
 *     atomic by construction, which kills the class of races the JSON
 *     path has been patching repeatedly.
 *
 * Schema version: 1 (initial). Consumers read `readStats()` and get the
 * same StatsFile shape the JSON path emits, so callers don't change.
 *
 * Toggle: ASHLR_STATS_BACKEND=json falls back to the legacy _stats.ts.
 * This module ignores that env var — the facade lives in the module that
 * chooses between backends (W-C4).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import type {
  ByDay,
  ByTool,
  LifetimeBucket,
  PerTool,
  SessionBucket,
  StatsFile,
  SummarizationStats,
} from "./_stats";

// ---------------------------------------------------------------------------
// Paths + session id (kept in sync with _stats.ts so both backends can
// be safely switched at runtime without drift).
// ---------------------------------------------------------------------------

function home(): string { return process.env.HOME ?? homedir(); }
/**
 * Path to ~/.ashlr/stats.db. Tests can override via ASHLR_STATS_DB_PATH
 * without touching the module — the env var is re-read on every open so
 * _resetConnection() + env swap is enough for isolation.
 */
export function dbPath(): string {
  const override = process.env.ASHLR_STATS_DB_PATH;
  return override && override.length > 0 ? override : join(home(), ".ashlr", "stats.db");
}

function ppidSessionId(): string {
  const seed = `ppid:${typeof process.ppid === "number" ? process.ppid : "?"}:${process.env.HOME ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(16)}`;
}

export function currentSessionId(): string {
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return ppidSessionId();
}

export function candidateSessionIds(): string[] {
  const ids = new Set<string>();
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) ids.add(explicit.trim());
  ids.add(ppidSessionId());
  return [...ids];
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  last_saving_at TEXT,
  calls          INTEGER NOT NULL DEFAULT 0,
  tokens_saved   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_tools (
  session_id   TEXT    NOT NULL,
  tool         TEXT    NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lifetime_tools (
  tool         TEXT    PRIMARY KEY,
  calls        INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lifetime_days (
  day          TEXT    PRIMARY KEY,
  calls        INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lifetime_totals (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  calls        INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS summarization (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  calls      INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lifetime_days_day_desc ON lifetime_days(day DESC);
`;

// ---------------------------------------------------------------------------
// Connection (singleton, lazily opened)
// ---------------------------------------------------------------------------

let _db: Database | null = null;

/** Open or return the cached connection. Ensures schema and seed rows exist. */
function db(): Database {
  if (_db) return _db;

  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });

  const conn = new Database(p);
  // busy_timeout MUST be set first so every subsequent statement — including
  // the WAL pragma and the DDL below — waits politely when another process
  // holds the write lock. 30s is generous; per-statement wait is bounded by
  // how long the longest in-flight tx takes (milliseconds in practice).
  conn.run("PRAGMA busy_timeout = 30000");
  // WAL mode is the whole point of migrating off JSON — concurrent writers
  // from multiple MCP server processes no longer need userland locking.
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA foreign_keys = ON");
  // synchronous=NORMAL is the recommended pairing with WAL — durability
  // is still crash-safe up to the last committed transaction and write
  // throughput nearly doubles vs FULL.
  conn.run("PRAGMA synchronous = NORMAL");

  // Wrap schema + singleton seeds in a BEGIN IMMEDIATE so concurrent openers
  // serialize across the DDL + seed-insert window. Without this, two
  // processes could both pass CREATE TABLE IF NOT EXISTS but then race into
  // INSERT OR IGNORE on a table that's still being created — observable as
  // transient SQLITE_BUSY on first-time open.
  conn.run("BEGIN IMMEDIATE");
  try {
    conn.exec(DDL_V1);
    conn.run(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', ?)",
      [String(SCHEMA_VERSION)],
    );
    conn.run("INSERT OR IGNORE INTO lifetime_totals (id, calls, tokens_saved) VALUES (1, 0, 0)");
    conn.run("INSERT OR IGNORE INTO summarization (id, calls, cache_hits) VALUES (1, 0, 0)");
    conn.run("COMMIT");
  } catch (err) {
    try { conn.run("ROLLBACK"); } catch { /* nothing to roll back */ }
    throw err;
  }

  _db = conn;
  return conn;
}

/** Test helper: close + forget the connection so a fresh one is opened next. */
export function _resetConnection(): void {
  if (_db) {
    try { _db.close(); } catch { /* ok */ }
    _db = null;
  }
}

/** Test helper: let tests point the store at a different path. */
export function _setDbPathForTests(override: string | null): void {
  _resetConnection();
  if (override === null) delete process.env.ASHLR_STATS_DB_PATH;
  else process.env.ASHLR_STATS_DB_PATH = override;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySession(): SessionBucket {
  return {
    startedAt: new Date().toISOString(),
    lastSavingAt: null,
    calls: 0,
    tokensSaved: 0,
    byTool: {},
  };
}

// Note: `emptyStats()` lives in _stats.ts — the dispatcher re-exports it.
// No sqlite-specific variant is needed because readStats() always synthesizes
// a fresh StatsFile from the db rows.

// ---------------------------------------------------------------------------
// Public API — mirrors _stats.ts
// ---------------------------------------------------------------------------

/**
 * Read the full stats file as an in-memory StatsFile. Called by
 * scripts/savings-dashboard.ts, scripts/savings-status-line.ts, etc.
 * One SQL round-trip per table; cheap compared to the JSON path's
 * parse-migrate-validate cycle.
 */
export async function readStats(): Promise<StatsFile> {
  const conn = db();

  const sessionsRows = conn
    .query<
      { session_id: string; started_at: string; last_saving_at: string | null; calls: number; tokens_saved: number },
      []
    >("SELECT session_id, started_at, last_saving_at, calls, tokens_saved FROM sessions")
    .all();

  const sessionToolRows = conn
    .query<
      { session_id: string; tool: string; calls: number; tokens_saved: number },
      []
    >("SELECT session_id, tool, calls, tokens_saved FROM session_tools")
    .all();

  const sessions: { [sessionId: string]: SessionBucket } = {};
  for (const row of sessionsRows) {
    sessions[row.session_id] = {
      startedAt: row.started_at,
      lastSavingAt: row.last_saving_at,
      calls: row.calls,
      tokensSaved: row.tokens_saved,
      byTool: {},
    };
  }
  for (const row of sessionToolRows) {
    const s = sessions[row.session_id];
    if (!s) continue; // orphan (shouldn't exist given FK + CASCADE)
    s.byTool[row.tool] = { calls: row.calls, tokensSaved: row.tokens_saved };
  }

  const totalsRow = conn
    .query<{ calls: number; tokens_saved: number }, []>(
      "SELECT calls, tokens_saved FROM lifetime_totals WHERE id = 1",
    )
    .get() ?? { calls: 0, tokens_saved: 0 };

  const lifetimeToolRows = conn
    .query<{ tool: string; calls: number; tokens_saved: number }, []>(
      "SELECT tool, calls, tokens_saved FROM lifetime_tools",
    )
    .all();
  const byTool: ByTool = {};
  for (const r of lifetimeToolRows) byTool[r.tool] = { calls: r.calls, tokensSaved: r.tokens_saved };

  const lifetimeDayRows = conn
    .query<{ day: string; calls: number; tokens_saved: number }, []>(
      "SELECT day, calls, tokens_saved FROM lifetime_days",
    )
    .all();
  const byDay: ByDay = {};
  for (const r of lifetimeDayRows) byDay[r.day] = { calls: r.calls, tokensSaved: r.tokens_saved };

  const summaryRow = conn
    .query<{ calls: number; cache_hits: number }, []>(
      "SELECT calls, cache_hits FROM summarization WHERE id = 1",
    )
    .get() ?? { calls: 0, cache_hits: 0 };

  return {
    schemaVersion: 2,
    sessions,
    lifetime: {
      calls: totalsRow.calls,
      tokensSaved: totalsRow.tokens_saved,
      byTool,
      byDay,
    },
    summarization: { calls: summaryRow.calls, cacheHits: summaryRow.cache_hits },
  };
}

/**
 * Record a tokens-saved event. Single SQL transaction touches up to 5 rows:
 * sessions, session_tools, lifetime_tools, lifetime_days, lifetime_totals.
 * Returns the computed savings so callers can surface an inline note.
 *
 * Never throws — errors are swallowed (observability is the crash-dump channel).
 */
export async function recordSaving(
  rawBytes: number,
  compactBytes: number,
  toolName: string,
  opts: { sessionId?: string } = {},
): Promise<number> {
  const saved = Math.max(0, Math.ceil((rawBytes - compactBytes) / 4));
  const sid = opts.sessionId ?? currentSessionId();
  const now = new Date().toISOString();
  const day = todayKey();

  try {
    const conn = db();
    const tx = conn.transaction(() => {
      // sessions: upsert — insert if new (seed startedAt), else bump counters + lastSavingAt.
      conn.run(
        `INSERT INTO sessions (session_id, started_at, last_saving_at, calls, tokens_saved)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_saving_at = excluded.last_saving_at,
           calls          = sessions.calls + 1,
           tokens_saved   = sessions.tokens_saved + excluded.tokens_saved`,
        [sid, now, now, saved],
      );

      // session_tools: upsert per (session, tool).
      conn.run(
        `INSERT INTO session_tools (session_id, tool, calls, tokens_saved)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(session_id, tool) DO UPDATE SET
           calls        = session_tools.calls + 1,
           tokens_saved = session_tools.tokens_saved + excluded.tokens_saved`,
        [sid, toolName, saved],
      );

      // lifetime_tools: same pattern.
      conn.run(
        `INSERT INTO lifetime_tools (tool, calls, tokens_saved)
         VALUES (?, 1, ?)
         ON CONFLICT(tool) DO UPDATE SET
           calls        = lifetime_tools.calls + 1,
           tokens_saved = lifetime_tools.tokens_saved + excluded.tokens_saved`,
        [toolName, saved],
      );

      // lifetime_days: today's bucket.
      conn.run(
        `INSERT INTO lifetime_days (day, calls, tokens_saved)
         VALUES (?, 1, ?)
         ON CONFLICT(day) DO UPDATE SET
           calls        = lifetime_days.calls + 1,
           tokens_saved = lifetime_days.tokens_saved + excluded.tokens_saved`,
        [day, saved],
      );

      // lifetime_totals: singleton.
      conn.run(
        "UPDATE lifetime_totals SET calls = calls + 1, tokens_saved = tokens_saved + ? WHERE id = 1",
        [saved],
      );
    });
    // IMMEDIATE mode: BEGIN IMMEDIATE acquires the write lock up front so
    // concurrent writers queue on busy_timeout instead of racing into a
    // deferred-transaction upgrade that aborts one side. Default DEFERRED
    // dropped ~10% of writes under cross-process contention in tests.
    tx.immediate();
  } catch (err) {
    // Best-effort: stats writes must never break tool execution. Log via
    // stderr so test harnesses (and anyone tailing logs) can see BUSY-level
    // contention; production can tail this via ASHLR_DEBUG=stats.
    if (process.env.ASHLR_DEBUG) {
      process.stderr.write(`[ashlr:stats] recordSaving failed: ${(err as Error).message}\n`);
    }
  }

  return saved;
}

/** Idempotently mint a session bucket (called by SessionStart hook). */
export async function initSessionBucket(
  sessionId: string = currentSessionId(),
): Promise<void> {
  try {
    const conn = db();
    conn.run(
      `INSERT OR IGNORE INTO sessions (session_id, started_at) VALUES (?, ?)`,
      [sessionId, new Date().toISOString()],
    );
  } catch { /* best-effort */ }
}

/**
 * Drop bucket(s) and return the combined SessionBucket for GC logging.
 * Mirrors _stats.ts behavior: when sessionId is omitted, drops every
 * candidate id so orphaned PPID-hash buckets get reaped too.
 */
export async function dropSessionBucket(
  sessionId?: string,
): Promise<SessionBucket | null> {
  const ids = sessionId ? [sessionId] : candidateSessionIds();
  try {
    const conn = db();
    return conn.transaction((): SessionBucket | null => {
      let calls = 0;
      let tokensSaved = 0;
      let startedAt = "";
      let lastSavingAt: string | null = null;
      const byTool: ByTool = {};
      let hit = false;

      const selectSession = conn.prepare<
        { started_at: string; last_saving_at: string | null; calls: number; tokens_saved: number },
        [string]
      >(
        "SELECT started_at, last_saving_at, calls, tokens_saved FROM sessions WHERE session_id = ?",
      );
      const selectTools = conn.prepare<
        { tool: string; calls: number; tokens_saved: number },
        [string]
      >(
        "SELECT tool, calls, tokens_saved FROM session_tools WHERE session_id = ?",
      );
      const deleteSession = conn.prepare<unknown, [string]>(
        "DELETE FROM sessions WHERE session_id = ?",
      );

      for (const id of ids) {
        const row = selectSession.get(id);
        if (!row) continue;
        hit = true;
        calls += row.calls;
        tokensSaved += row.tokens_saved;
        if (!startedAt || row.started_at < startedAt) startedAt = row.started_at;
        if (row.last_saving_at && (!lastSavingAt || row.last_saving_at > lastSavingAt)) {
          lastSavingAt = row.last_saving_at;
        }
        for (const tr of selectTools.all(id)) {
          const t = byTool[tr.tool] ?? (byTool[tr.tool] = { calls: 0, tokensSaved: 0 });
          t.calls += tr.calls;
          t.tokensSaved += tr.tokens_saved;
        }
        deleteSession.run(id); // CASCADE removes session_tools
      }

      return hit
        ? {
            startedAt: startedAt || new Date().toISOString(),
            lastSavingAt,
            calls,
            tokensSaved,
            byTool,
          }
        : null;
    }).immediate();
  } catch {
    return null;
  }
}

/** Bump a summarization counter (calls | cacheHits). */
export async function bumpSummarization(
  field: "calls" | "cacheHits",
): Promise<void> {
  const col = field === "calls" ? "calls" : "cache_hits";
  try {
    // IMMEDIATE transaction so concurrent callers queue on busy_timeout
    // instead of silently dropping the bump on SQLITE_BUSY. Same discipline
    // as recordSaving; the summarization counter is heavily bumped during
    // LLM-summarize bursts.
    const conn = db();
    const tx = conn.transaction(() => {
      conn.run(
        `UPDATE summarization SET ${col} = ${col} + 1 WHERE id = 1`,
      );
    });
    tx.immediate();
  } catch { /* best-effort */ }
}

/**
 * Read a single session's bucket (status-line / savings dashboard).
 * Returns an empty bucket when the session hasn't been seeded yet so the
 * status-line can render "0 calls" cleanly.
 */
export async function readCurrentSession(
  sessionId?: string,
): Promise<SessionBucket> {
  const conn = db();
  const ids = sessionId ? [sessionId] : candidateSessionIds();

  let best: SessionBucket | null = null;
  for (const id of ids) {
    const row = conn
      .query<
        { started_at: string; last_saving_at: string | null; calls: number; tokens_saved: number },
        [string]
      >(
        "SELECT started_at, last_saving_at, calls, tokens_saved FROM sessions WHERE session_id = ?",
      )
      .get(id);
    if (!row) continue;
    const byTool: ByTool = {};
    const toolRows = conn
      .query<{ tool: string; calls: number; tokens_saved: number }, [string]>(
        "SELECT tool, calls, tokens_saved FROM session_tools WHERE session_id = ?",
      )
      .all(id);
    for (const t of toolRows) byTool[t.tool] = { calls: t.calls, tokensSaved: t.tokens_saved };
    const candidate: SessionBucket = {
      startedAt: row.started_at,
      lastSavingAt: row.last_saving_at,
      calls: row.calls,
      tokensSaved: row.tokens_saved,
      byTool,
    };
    // Prefer the one with more activity (same tiebreak the JSON path uses).
    if (!best || candidate.calls > best.calls) best = candidate;
  }
  return best ?? emptySession();
}

// ---------------------------------------------------------------------------
// Migration helpers — used by scripts/migrate-stats-to-sqlite.ts
// ---------------------------------------------------------------------------

/**
 * Bulk-import a StatsFile (typically loaded from ~/.ashlr/stats.json) into
 * the sqlite store. Single transaction. Idempotent if the db is already
 * seeded from an earlier migration pass — INSERT OR REPLACE everywhere.
 */
export function importStatsFile(s: StatsFile): void {
  const conn = db();
  conn.transaction(() => {
    // Lifetime totals — replace the singleton.
    conn.run(
      "UPDATE lifetime_totals SET calls = ?, tokens_saved = ? WHERE id = 1",
      [s.lifetime.calls, s.lifetime.tokensSaved],
    );

    // Lifetime per-tool.
    for (const [tool, pt] of Object.entries(s.lifetime.byTool)) {
      conn.run(
        "INSERT OR REPLACE INTO lifetime_tools (tool, calls, tokens_saved) VALUES (?, ?, ?)",
        [tool, pt.calls, pt.tokensSaved],
      );
    }

    // Lifetime per-day.
    for (const [day, pd] of Object.entries(s.lifetime.byDay)) {
      conn.run(
        "INSERT OR REPLACE INTO lifetime_days (day, calls, tokens_saved) VALUES (?, ?, ?)",
        [day, pd.calls, pd.tokensSaved],
      );
    }

    // Summarization singleton.
    const sm = s.summarization ?? { calls: 0, cacheHits: 0 };
    conn.run(
      "UPDATE summarization SET calls = ?, cache_hits = ? WHERE id = 1",
      [sm.calls, sm.cacheHits],
    );

    // Sessions + their per-tool breakdowns.
    for (const [sid, bucket] of Object.entries(s.sessions)) {
      conn.run(
        `INSERT OR REPLACE INTO sessions
          (session_id, started_at, last_saving_at, calls, tokens_saved)
         VALUES (?, ?, ?, ?, ?)`,
        [sid, bucket.startedAt, bucket.lastSavingAt, bucket.calls, bucket.tokensSaved],
      );
      for (const [tool, pt] of Object.entries(bucket.byTool)) {
        conn.run(
          `INSERT OR REPLACE INTO session_tools
            (session_id, tool, calls, tokens_saved)
           VALUES (?, ?, ?, ?)`,
          [sid, tool, pt.calls, pt.tokensSaved],
        );
      }
    }
  }).immediate();
}

// Re-export shape types so consumers importing from _stats-sqlite get the
// same surface they'd get from _stats.
export type {
  ByDay,
  ByTool,
  LifetimeBucket,
  PerTool,
  SessionBucket,
  StatsFile,
  SummarizationStats,
};
