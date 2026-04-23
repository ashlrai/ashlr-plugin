/**
 * stats-dispatcher.test.ts — covers the `useSqlite()` branch in every
 * exported async function of `servers/_stats.ts`.
 *
 * Why this file exists: the SQLite tests in `stats-sqlite.test.ts` import
 * `_stats-sqlite.ts` directly, bypassing the dispatcher. The JSON tests
 * never set `ASHLR_STATS_BACKEND=sqlite`. So the wiring that makes
 * `ASHLR_STATS_BACKEND=sqlite` actually route calls to the SQLite backend
 * was completely uncovered — a rename on one side would silently break
 * production with only TypeScript as the net.
 *
 * This file calls each public entry point of `_stats.ts` with the env flag
 * set and asserts the calls land in the SQLite db.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  bumpSummarization,
  dropSessionBucket,
  initSessionBucket,
  readCurrentSession,
  readStats,
  recordSaving,
} from "../servers/_stats";
import {
  _resetConnection,
  _setDbPathForTests,
  dbPath,
} from "../servers/_stats-sqlite";

let SANDBOX: string;
let PRIOR_BACKEND: string | undefined;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "ashlr-stats-dispatcher-"));
  _setDbPathForTests(join(SANDBOX, "stats.db"));
  PRIOR_BACKEND = process.env.ASHLR_STATS_BACKEND;
  process.env.ASHLR_STATS_BACKEND = "sqlite";
});

afterEach(() => {
  _resetConnection();
  _setDbPathForTests(null);
  if (PRIOR_BACKEND === undefined) delete process.env.ASHLR_STATS_BACKEND;
  else process.env.ASHLR_STATS_BACKEND = PRIOR_BACKEND;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("servers/_stats.ts dispatcher — ASHLR_STATS_BACKEND=sqlite", () => {
  it("recordSaving routes to the SQLite backend", async () => {
    const saved = await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    expect(saved).toBeGreaterThan(0);

    // Data lands in the sqlite db, NOT in stats.json.
    const raw = new Database(dbPath());
    const row = raw
      .query<{ calls: number; tokens_saved: number }, []>(
        "SELECT calls, tokens_saved FROM lifetime_totals WHERE id = 1",
      )
      .get();
    raw.close();
    expect(row?.calls).toBe(1);
    expect(row?.tokens_saved).toBe(saved);
  });

  it("readStats routes to the SQLite backend", async () => {
    await recordSaving(8192, 1024, "ashlr__grep", { sessionId: "s1" });
    const stats = await readStats();
    expect(stats.schemaVersion).toBe(2);
    expect(stats.lifetime.calls).toBe(1);
    expect(stats.sessions["s1"]).toBeDefined();
  });

  it("initSessionBucket routes to the SQLite backend", async () => {
    await initSessionBucket("warm");
    const stats = await readStats();
    expect(stats.sessions["warm"]).toBeDefined();
    expect(stats.sessions["warm"]!.calls).toBe(0);
  });

  it("dropSessionBucket routes to the SQLite backend", async () => {
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    const dropped = await dropSessionBucket("s1");
    expect(dropped).not.toBeNull();
    expect(dropped!.calls).toBe(1);
  });

  it("bumpSummarization routes to the SQLite backend", async () => {
    await bumpSummarization("calls");
    await bumpSummarization("cacheHits");
    const stats = await readStats();
    expect(stats.summarization?.calls).toBe(1);
    expect(stats.summarization?.cacheHits).toBe(1);
  });

  it("readCurrentSession routes to the SQLite backend", async () => {
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    const bucket = await readCurrentSession("s1");
    expect(bucket.calls).toBe(1);
    expect(bucket.byTool["ashlr__read"]?.calls).toBe(1);
  });

  // Note: the inverse path (ASHLR_STATS_BACKEND unset → JSON backend) is
  // exercised implicitly by the entire rest of the test suite, which never
  // sets the flag and reads/writes through `_stats.ts`'s JSON code path.
});
