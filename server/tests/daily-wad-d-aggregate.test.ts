/**
 * daily-wad-d-aggregate.test.ts — Tests for the daily WAD-D aggregator.
 *
 * Covers:
 *   1. Computes correct WAD-D for 3 synthetic identities with varied
 *      active-day patterns (1, 3, 5, 7 days in window).
 *   2. Folds github_hash duplicates — one developer using 2 machines counts
 *      once.
 *   3. Idempotent: running aggregator twice for the same snapshot_date
 *      updates the existing row instead of inserting a duplicate.
 *   4. Dry-run does not write to wad_d_snapshots.
 *   5. Lead indicators are populated correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDb, _resetDb, getDb } from "../src/db.js";
import { runDailyWadDAggregate } from "../src/jobs/daily-wad-d-aggregate.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

function hex(seed: string): string {
  // Deterministic 64-char hex from a label — fine for tests.
  return seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");
}

function insertRecord(
  identityHash: string,
  date: string,
  githubHash: string | null = null,
): void {
  getDb().run(
    `INSERT OR IGNORE INTO daily_active_records
       (identity_hash, github_hash, active_date, plugin_version)
     VALUES (?, ?, ?, ?)`,
    [identityHash, githubHash, date, "1.30.0"],
  );
}

// Anchor the window to a known date.
const SNAPSHOT_DATE = "2026-05-22";
// Window = 2026-05-16 ... 2026-05-22 (7 days).
const WINDOW_DAYS = [
  "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19",
  "2026-05-20", "2026-05-21", "2026-05-22",
];

describe("runDailyWadDAggregate", () => {
  beforeEach(() => { freshDb(); });
  afterEach(() => { _resetDb(); });

  it("counts WAD-D from varied per-identity active-day patterns", () => {
    const alice = hex("alice");    // 7 days → counted
    const bob   = hex("bob");      // 5 days → counted (boundary)
    const carol = hex("carol");    // 3 days → NOT counted
    const dave  = hex("dave");     // 1 day  → NOT counted

    for (const d of WINDOW_DAYS) insertRecord(alice, d);
    for (const d of WINDOW_DAYS.slice(0, 5)) insertRecord(bob, d);
    for (const d of WINDOW_DAYS.slice(0, 3)) insertRecord(carol, d);
    insertRecord(dave, WINDOW_DAYS[0]!);

    const result = runDailyWadDAggregate({ snapshotDate: SNAPSHOT_DATE });

    expect(result.snapshot_date).toBe(SNAPSHOT_DATE);
    expect(result.wad_d_value).toBe(2); // alice + bob
    expect(result.lead_indicators.identities_seen).toBe(4);
    expect(result.lead_indicators.identities_1d_plus).toBe(4);
    expect(result.lead_indicators.identities_3d_plus).toBe(3); // alice/bob/carol
    expect(result.lead_indicators.identities_5d_plus).toBe(2); // alice/bob
    expect(result.lead_indicators.identities_7d_plus).toBe(1); // alice
    expect(result.written).toBe(true);

    // Persisted row matches computed value.
    const row = getDb()
      .query<{ wad_d_value: number; lead_indicators_json: string | null }, [string]>(
        `SELECT wad_d_value, lead_indicators_json FROM wad_d_snapshots WHERE snapshot_date = ?`,
      )
      .get(SNAPSHOT_DATE);
    expect(row?.wad_d_value).toBe(2);
    expect(row?.lead_indicators_json).toBeTruthy();
  });

  it("folds multiple machines under one github_hash into one identity", () => {
    const sharedGithub = hex("masongh");
    const machineA = hex("machine_a");
    const machineB = hex("machine_b");
    // Both machines, same github_hash, hitting 5 distinct days between them.
    insertRecord(machineA, "2026-05-18", sharedGithub);
    insertRecord(machineA, "2026-05-19", sharedGithub);
    insertRecord(machineA, "2026-05-20", sharedGithub);
    insertRecord(machineB, "2026-05-21", sharedGithub);
    insertRecord(machineB, "2026-05-22", sharedGithub);

    // A separate single-day user should NOT count.
    insertRecord(hex("singleton"), "2026-05-22");

    const result = runDailyWadDAggregate({ snapshotDate: SNAPSHOT_DATE });
    expect(result.wad_d_value).toBe(1);
    expect(result.lead_indicators.identities_seen).toBe(2); // shared + singleton
  });

  it("is idempotent — re-running for the same snapshot_date updates instead of duplicating", () => {
    const alice = hex("alice");
    for (const d of WINDOW_DAYS) insertRecord(alice, d);

    runDailyWadDAggregate({ snapshotDate: SNAPSHOT_DATE });
    runDailyWadDAggregate({ snapshotDate: SNAPSHOT_DATE });

    const rows = getDb()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM wad_d_snapshots WHERE snapshot_date = ?`,
      )
      .get(SNAPSHOT_DATE);
    expect(rows?.n).toBe(1);
  });

  it("dry-run: computes WAD-D but does NOT write a snapshot row", () => {
    const alice = hex("alice");
    for (const d of WINDOW_DAYS) insertRecord(alice, d);

    const result = runDailyWadDAggregate({ snapshotDate: SNAPSHOT_DATE, dryRun: true });
    expect(result.wad_d_value).toBe(1);
    expect(result.written).toBe(false);

    const row = getDb()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM wad_d_snapshots WHERE snapshot_date = ?`,
      )
      .get(SNAPSHOT_DATE);
    expect(row?.n).toBe(0);
  });

  it("returns wad_d_value=0 when there are no records in the window", () => {
    // Insert one record OUTSIDE the 7-day window — should be excluded.
    insertRecord(hex("outsider"), "2026-04-01");
    const result = runDailyWadDAggregate({ snapshotDate: SNAPSHOT_DATE });
    expect(result.wad_d_value).toBe(0);
    expect(result.lead_indicators.identities_seen).toBe(0);
  });
});
