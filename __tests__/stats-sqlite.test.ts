/**
 * stats-sqlite.test.ts — covers the SQLite-backed stats store.
 *
 * Each test uses a fresh temp db via ASHLR_STATS_DB_PATH so we avoid
 * stepping on the developer's real ~/.ashlr/stats.db.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  _setDbPathForTests,
  _resetConnection,
  bumpSummarization,
  dbPath,
  dropSessionBucket,
  importStatsFile,
  initSessionBucket,
  readCurrentSession,
  readStats,
  recordSaving,
} from "../servers/_stats-sqlite";

let SANDBOX: string;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "ashlr-stats-sqlite-"));
  _setDbPathForTests(join(SANDBOX, "stats.db"));
});

afterEach(() => {
  _resetConnection();
  _setDbPathForTests(null);
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("servers/_stats-sqlite.ts", () => {
  it("recordSaving bumps session + lifetime counters atomically", async () => {
    const saved = await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    expect(saved).toBeGreaterThan(0); // (8192-1024)/4 ceil

    const stats = await readStats();
    expect(stats.lifetime.calls).toBe(1);
    expect(stats.lifetime.tokensSaved).toBe(saved);
    expect(stats.lifetime.byTool["ashlr__read"]?.calls).toBe(1);
    expect(stats.lifetime.byTool["ashlr__read"]?.tokensSaved).toBe(saved);

    const s1 = stats.sessions["s1"];
    expect(s1).toBeDefined();
    expect(s1!.calls).toBe(1);
    expect(s1!.tokensSaved).toBe(saved);
    expect(s1!.byTool["ashlr__read"]?.calls).toBe(1);
  });

  it("recordSaving returns 0 when compactBytes >= rawBytes (no waste)", async () => {
    const saved = await recordSaving(1024, 2048, "ashlr__grep", { sessionId: "s1" });
    expect(saved).toBe(0);
    // But the call still counts — the math just produced 0 savings.
    const stats = await readStats();
    expect(stats.lifetime.calls).toBe(1);
    expect(stats.lifetime.tokensSaved).toBe(0);
  });

  it("repeated calls on the same (session, tool) accumulate correctly", async () => {
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    await recordSaving(4096, 512, "ashlr__read", { sessionId: "s1" });
    await recordSaving(2048, 1024, "ashlr__grep", { sessionId: "s1" });

    const stats = await readStats();
    expect(stats.lifetime.calls).toBe(3);
    expect(stats.lifetime.byTool["ashlr__read"]?.calls).toBe(2);
    expect(stats.lifetime.byTool["ashlr__grep"]?.calls).toBe(1);

    const s1 = stats.sessions["s1"]!;
    expect(s1.calls).toBe(3);
    expect(Object.keys(s1.byTool).sort()).toEqual(["ashlr__grep", "ashlr__read"]);
  });

  it("writes across two sessions stay isolated in the sessions map", async () => {
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s2" });

    const stats = await readStats();
    expect(Object.keys(stats.sessions).sort()).toEqual(["s1", "s2"]);
    expect(stats.lifetime.calls).toBe(2);
  });

  it("initSessionBucket is idempotent", async () => {
    await initSessionBucket("s1");
    await initSessionBucket("s1");
    const stats = await readStats();
    expect(stats.sessions["s1"]).toBeDefined();
    expect(stats.sessions["s1"]!.calls).toBe(0);
  });

  it("dropSessionBucket returns the combined bucket and CASCADE-removes tools", async () => {
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    await recordSaving(4096, 512, "ashlr__grep", { sessionId: "s1" });

    const dropped = await dropSessionBucket("s1");
    expect(dropped).not.toBeNull();
    expect(dropped!.calls).toBe(2);
    expect(Object.keys(dropped!.byTool).sort()).toEqual(["ashlr__grep", "ashlr__read"]);

    const stats = await readStats();
    expect(stats.sessions["s1"]).toBeUndefined();
    // Lifetime is preserved — dropping a session bucket is a GC, not a refund.
    expect(stats.lifetime.calls).toBe(2);

    // Raw assertion that the FK CASCADE actually wiped session_tools, not
    // just the sessions row. Without CASCADE (e.g. if PRAGMA foreign_keys
    // got disabled), readStats() skips orphan rows so the JSON assertion
    // above would pass silently while the db kept growing.
    const rawDb = new Database(dbPath());
    const orphan = rawDb
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_tools WHERE session_id = 's1'")
      .get();
    rawDb.close();
    expect(orphan?.n).toBe(0);
  });

  it("dropSessionBucket returns null when nothing to drop", async () => {
    const dropped = await dropSessionBucket("never-existed");
    expect(dropped).toBeNull();
  });

  it("bumpSummarization increments calls and cacheHits independently", async () => {
    await bumpSummarization("calls");
    await bumpSummarization("calls");
    await bumpSummarization("cacheHits");

    const stats = await readStats();
    expect(stats.summarization?.calls).toBe(2);
    expect(stats.summarization?.cacheHits).toBe(1);
  });

  it("readCurrentSession returns an empty bucket when the session isn't seeded", async () => {
    const b = await readCurrentSession("unknown");
    expect(b.calls).toBe(0);
    expect(b.tokensSaved).toBe(0);
    expect(b.byTool).toEqual({});
  });

  it("importStatsFile bulk-loads a StatsFile shape", () => {
    importStatsFile({
      schemaVersion: 2,
      sessions: {
        s1: {
          startedAt: "2026-04-22T10:00:00Z",
          lastSavingAt: "2026-04-22T10:10:00Z",
          calls: 4,
          tokensSaved: 1000,
          byTool: { "ashlr__read": { calls: 3, tokensSaved: 900 }, "ashlr__grep": { calls: 1, tokensSaved: 100 } },
        },
      },
      lifetime: {
        calls: 4,
        tokensSaved: 1000,
        byTool: { "ashlr__read": { calls: 3, tokensSaved: 900 }, "ashlr__grep": { calls: 1, tokensSaved: 100 } },
        byDay: { "2026-04-22": { calls: 4, tokensSaved: 1000 } },
      },
      summarization: { calls: 5, cacheHits: 2 },
    });
  });

  it("importStatsFile round-trips through readStats unchanged", async () => {
    const src = {
      schemaVersion: 2 as const,
      sessions: {
        s1: {
          startedAt: "2026-04-22T10:00:00Z",
          lastSavingAt: "2026-04-22T10:10:00Z",
          calls: 2,
          tokensSaved: 500,
          byTool: { "ashlr__read": { calls: 2, tokensSaved: 500 } },
        },
      },
      lifetime: {
        calls: 2,
        tokensSaved: 500,
        byTool: { "ashlr__read": { calls: 2, tokensSaved: 500 } },
        byDay: { "2026-04-22": { calls: 2, tokensSaved: 500 } },
      },
      summarization: { calls: 1, cacheHits: 0 },
    };
    importStatsFile(src);

    const roundTrip = await readStats();
    expect(roundTrip.lifetime).toEqual(src.lifetime);
    expect(roundTrip.sessions.s1).toEqual(src.sessions.s1);
    expect(roundTrip.summarization).toEqual(src.summarization);
  });

  it("creates the db file and its parent directory on first write", async () => {
    const dbFile = join(SANDBOX, "stats.db");
    expect(existsSync(dbFile)).toBe(false); // SANDBOX was just mkdtemp'd
    await recordSaving(8192, 1024, "ashlr__read", { sessionId: "s1" });
    expect(existsSync(dbFile)).toBe(true);
  });
});
