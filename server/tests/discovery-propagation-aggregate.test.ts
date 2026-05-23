/**
 * discovery-propagation-aggregate.test.ts — Tests for
 * runDiscoveryPropagationAggregate.
 *
 * Covers (5 tests):
 *   1. Empty data            -> returns {0,0}, writes no rows.
 *   2. Single discovery, 1 session -> row with counts (1,1).
 *   3. Same discovery across 5 sessions and 3 identities
 *                            -> row with (5,3).
 *   4. Malformed JSON row    -> counted as error, doesn't crash; other rows
 *                               in same scan still produce a row.
 *   5. Re-run is idempotent  -> counts stable across two invocations.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDb, _resetDb, getDb } from "../src/db.js";
import { runDiscoveryPropagationAggregate } from "../src/jobs/discovery-propagation-aggregate.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

function hex(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");
}

interface InsertOpts {
  identity: string;
  session: string;
  endedAt: string;
  refsJson: string;
}

function insertSessionEvent(opts: InsertOpts): void {
  getDb().run(
    `INSERT INTO session_events
       (identity_hash, github_hash, session_id_hash, ended_at,
        tool_count, tokens_saved, branch_sha, discovery_refs_json, plugin_version)
     VALUES (?, NULL, ?, ?, 0, 0, NULL, ?, ?)`,
    [opts.identity, opts.session, opts.endedAt, opts.refsJson, "1.30.0"],
  );
}

interface StatRow {
  discovery_id: string;
  first_seen_at: string;
  last_seen_at: string;
  session_count: number;
  distinct_identity_count: number;
}

function readStats(): StatRow[] {
  return getDb()
    .query(
      `SELECT discovery_id, first_seen_at, last_seen_at,
              session_count, distinct_identity_count
       FROM discovery_propagation_stats
       ORDER BY discovery_id ASC`,
    )
    .all() as StatRow[];
}

describe("runDiscoveryPropagationAggregate", () => {
  beforeEach(() => {
    freshDb();
  });
  afterEach(() => {
    _resetDb();
  });

  it("returns {0,0} and writes no rows when there are no session_events", async () => {
    const result = await runDiscoveryPropagationAggregate({ since: new Date('2020-01-01T00:00:00Z') });
    expect(result.discoveriesProcessed).toBe(0);
    expect(result.errors).toBe(0);
    expect(readStats().length).toBe(0);
  });

  it("counts a single discovery touched by one session", async () => {
    insertSessionEvent({
      identity: hex("alice"),
      session: hex("session1"),
      endedAt: "2026-05-21T10:00:00Z",
      refsJson: JSON.stringify(["auth-bug-q4"]),
    });

    const result = await runDiscoveryPropagationAggregate({ since: new Date('2020-01-01T00:00:00Z') });
    expect(result.discoveriesProcessed).toBe(1);
    expect(result.errors).toBe(0);

    const rows = readStats();
    expect(rows.length).toBe(1);
    expect(rows[0]!.discovery_id).toBe("auth-bug-q4");
    expect(rows[0]!.session_count).toBe(1);
    expect(rows[0]!.distinct_identity_count).toBe(1);
    expect(rows[0]!.first_seen_at).toBe("2026-05-21T10:00:00Z");
    expect(rows[0]!.last_seen_at).toBe("2026-05-21T10:00:00Z");
  });

  it("folds 5 sessions across 3 identities into (5,3)", async () => {
    const id1 = hex("dev1");
    const id2 = hex("dev2");
    const id3 = hex("dev3");
    const discovery = "shared-finding";

    // dev1 touches 2 sessions, dev2 touches 2 sessions, dev3 touches 1
    insertSessionEvent({
      identity: id1, session: hex("s1"), endedAt: "2026-05-20T09:00:00Z",
      refsJson: JSON.stringify([discovery]),
    });
    insertSessionEvent({
      identity: id1, session: hex("s2"), endedAt: "2026-05-21T09:00:00Z",
      refsJson: JSON.stringify([discovery]),
    });
    insertSessionEvent({
      identity: id2, session: hex("s3"), endedAt: "2026-05-22T09:00:00Z",
      refsJson: JSON.stringify([discovery]),
    });
    insertSessionEvent({
      identity: id2, session: hex("s4"), endedAt: "2026-05-22T10:00:00Z",
      refsJson: JSON.stringify([discovery]),
    });
    insertSessionEvent({
      identity: id3, session: hex("s5"), endedAt: "2026-05-22T11:00:00Z",
      refsJson: JSON.stringify([discovery]),
    });

    const result = await runDiscoveryPropagationAggregate({ since: new Date('2020-01-01T00:00:00Z') });
    expect(result.discoveriesProcessed).toBe(1);
    expect(result.errors).toBe(0);

    const rows = readStats();
    expect(rows.length).toBe(1);
    expect(rows[0]!.session_count).toBe(5);
    expect(rows[0]!.distinct_identity_count).toBe(3);
    expect(rows[0]!.first_seen_at).toBe("2026-05-20T09:00:00Z");
    expect(rows[0]!.last_seen_at).toBe("2026-05-22T11:00:00Z");
  });

  it("counts malformed JSON rows as errors and continues processing siblings", async () => {
    // Row 1: malformed (not valid JSON).
    insertSessionEvent({
      identity: hex("alice"),
      session: hex("s1"),
      endedAt: "2026-05-20T09:00:00Z",
      refsJson: "{not-valid-json",
    });
    // Row 2: valid array, should still produce a stat.
    insertSessionEvent({
      identity: hex("bob"),
      session: hex("s2"),
      endedAt: "2026-05-21T09:00:00Z",
      refsJson: JSON.stringify(["ok-discovery"]),
    });
    // Row 3: valid JSON but not an array — also counted as error.
    insertSessionEvent({
      identity: hex("carol"),
      session: hex("s3"),
      endedAt: "2026-05-22T09:00:00Z",
      refsJson: JSON.stringify({ not: "an-array" }),
    });

    const result = await runDiscoveryPropagationAggregate({ since: new Date('2020-01-01T00:00:00Z') });
    expect(result.errors).toBe(2);
    expect(result.discoveriesProcessed).toBe(1);

    const rows = readStats();
    expect(rows.length).toBe(1);
    expect(rows[0]!.discovery_id).toBe("ok-discovery");
    expect(rows[0]!.session_count).toBe(1);
    expect(rows[0]!.distinct_identity_count).toBe(1);
  });

  it("is idempotent — re-running produces stable counts", async () => {
    insertSessionEvent({
      identity: hex("alice"),
      session: hex("s1"),
      endedAt: "2026-05-21T09:00:00Z",
      refsJson: JSON.stringify(["d1", "d2"]),
    });
    insertSessionEvent({
      identity: hex("bob"),
      session: hex("s2"),
      endedAt: "2026-05-22T09:00:00Z",
      refsJson: JSON.stringify(["d1"]),
    });

    await runDiscoveryPropagationAggregate({ since: new Date('2020-01-01T00:00:00Z') });
    const first = readStats();
    await runDiscoveryPropagationAggregate({ since: new Date('2020-01-01T00:00:00Z') });
    const second = readStats();

    expect(second.length).toBe(first.length);
    expect(second.length).toBe(2);
    // d1 hit by alice+bob, d2 only by alice
    const d1 = second.find((r) => r.discovery_id === "d1")!;
    const d2 = second.find((r) => r.discovery_id === "d2")!;
    expect(d1.session_count).toBe(2);
    expect(d1.distinct_identity_count).toBe(2);
    expect(d2.session_count).toBe(1);
    expect(d2.distinct_identity_count).toBe(1);

    // Compare first vs second to confirm identical aggregate state.
    for (const key of ["session_count", "distinct_identity_count"] as const) {
      expect(d1[key]).toBe(first.find((r) => r.discovery_id === "d1")![key]);
      expect(d2[key]).toBe(first.find((r) => r.discovery_id === "d2")![key]);
    }
  });
});
