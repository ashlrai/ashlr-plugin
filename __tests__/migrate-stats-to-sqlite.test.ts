/**
 * migrate-stats-to-sqlite.test.ts — the one-shot migration helper.
 *
 * Uses ASHLR_STATS_DB_PATH + ASHLR_STATS_JSON_PATH so the two backends
 * are redirected independently; neither touches the developer's real
 * ~/.ashlr/ directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { _setDbPathForTests, _resetConnection, readStats } from "../servers/_stats-sqlite";
import { migrateStatsIfNeeded } from "../scripts/migrate-stats-to-sqlite";

let SANDBOX: string;

function writeLegacyJson(home: string, payload: object): string {
  const dir = join(home, ".ashlr");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "stats.json");
  writeFileSync(path, JSON.stringify(payload), "utf-8");
  return path;
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "ashlr-stats-migrate-"));
  // Point the SQLite backend at the sandbox.
  _setDbPathForTests(join(SANDBOX, "stats.db"));
  // The legacy _stats.ts reads HOME/.ashlr/stats.json — redirect HOME.
  process.env.HOME = SANDBOX;
});

afterEach(() => {
  _resetConnection();
  _setDbPathForTests(null);
  delete process.env.HOME;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("scripts/migrate-stats-to-sqlite.ts", () => {
  it("no-op when neither legacy JSON nor db exists (fresh install)", async () => {
    const r = await migrateStatsIfNeeded();
    expect(r.migrated).toBe(false);
    expect(r.reason).toBe("no-legacy-json");
  });

  it("migrates legacy JSON into stats.db and renames the source", async () => {
    writeLegacyJson(SANDBOX, {
      schemaVersion: 2,
      sessions: {
        s1: {
          startedAt: "2026-04-22T10:00:00Z",
          lastSavingAt: "2026-04-22T10:10:00Z",
          calls: 3,
          tokensSaved: 750,
          byTool: { "ashlr__read": { calls: 3, tokensSaved: 750 } },
        },
      },
      lifetime: {
        calls: 3,
        tokensSaved: 750,
        byTool: { "ashlr__read": { calls: 3, tokensSaved: 750 } },
        byDay: { "2026-04-22": { calls: 3, tokensSaved: 750 } },
      },
      summarization: { calls: 2, cacheHits: 1 },
    });

    const r = await migrateStatsIfNeeded();
    expect(r.migrated).toBe(true);
    expect(r.reason).toBe("migrated-ok");
    expect(r.sessions).toBe(1);
    expect(r.lifetimeCalls).toBe(3);

    // DB has the rows.
    const after = await readStats();
    expect(after.lifetime.calls).toBe(3);
    expect(after.lifetime.tokensSaved).toBe(750);
    expect(after.sessions.s1?.calls).toBe(3);
    expect(after.summarization?.calls).toBe(2);

    // Legacy JSON has been renamed out of the way.
    const ashlrDir = join(SANDBOX, ".ashlr");
    const entries = readdirSync(ashlrDir).filter((f) => f.startsWith("stats.json"));
    expect(entries.some((e) => /^stats\.json\.migrated-\d+$/.test(e))).toBe(true);
    expect(existsSync(join(ashlrDir, "stats.json"))).toBe(false);
  });

  it("no-op when the db already exists (idempotent across reruns)", async () => {
    // First pass — populate the db.
    writeLegacyJson(SANDBOX, {
      schemaVersion: 2,
      sessions: {},
      lifetime: { calls: 1, tokensSaved: 100, byTool: {}, byDay: {} },
    });
    const first = await migrateStatsIfNeeded();
    expect(first.migrated).toBe(true);

    // Second pass — db already exists, should bail fast.
    const second = await migrateStatsIfNeeded();
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe("db-already-exists");
  });

  it("renames even an empty legacy JSON so we don't re-check forever", async () => {
    writeLegacyJson(SANDBOX, {
      schemaVersion: 2,
      sessions: {},
      lifetime: { calls: 0, tokensSaved: 0, byTool: {}, byDay: {} },
    });
    const r = await migrateStatsIfNeeded();
    expect(r.migrated).toBe(true);
    expect(r.reason).toBe("empty-legacy-json");
    expect(existsSync(join(SANDBOX, ".ashlr", "stats.json"))).toBe(false);
  });
});
