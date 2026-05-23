/**
 * orchestrate-usage-aggregate.test.ts — Tests for runOrchestrateUsageAggregate.
 *
 * Covers (6 tests):
 *   1. Empty orchestration_runs                 -> 0 buckets processed.
 *   2. Single run with github_hash              -> 1 bucket, graphs_run=1.
 *   3. 5 runs spread across 2 hashes x 2 months -> 4 buckets.
 *   4. Anonymous runs (github_hash NULL) are excluded.
 *   5. Re-run is idempotent (counts stable).
 *   6. SUM aggregation: agents_spawned, tokens_in, tokens_out math correct.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDb, _resetDb, getDb } from "../src/db.js";
import { runOrchestrateUsageAggregate } from "../src/jobs/orchestrate-usage-aggregate.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  _setDb(db);
  return db;
}

function hex(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");
}

interface InsertRunOpts {
  identity: string;
  githubHash: string | null;
  graphId?: string;
  goal?: string;
  tier?: "pro" | "team";
  mode?: "stub" | "real-llm";
  startedAt: string; // ISO timestamp
  finishedAt?: string;
  durationMs?: number;
  nodeCount?: number;
  failCount?: number;
  ok?: 0 | 1;
  tokensIn?: number;
  tokensOut?: number;
}

let runCounter = 0;
function insertRun(opts: InsertRunOpts): void {
  runCounter += 1;
  getDb().run(
    `INSERT INTO orchestration_runs
       (identity_hash, github_hash, graph_id, goal, tier, mode,
        started_at, finished_at, duration_ms,
        node_count, fail_count, ok, total_tokens_in, total_tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.identity,
      opts.githubHash,
      opts.graphId ?? `g-${runCounter}`,
      opts.goal ?? "test goal",
      opts.tier ?? "team",
      opts.mode ?? "stub",
      opts.startedAt,
      opts.finishedAt ?? opts.startedAt,
      opts.durationMs ?? 1000,
      opts.nodeCount ?? 3,
      opts.failCount ?? 0,
      opts.ok ?? 1,
      opts.tokensIn ?? 0,
      opts.tokensOut ?? 0,
    ],
  );
}

interface UsageRow {
  team_bucket: string;
  month_key: string;
  graphs_run: number;
  agents_spawned: number;
  tokens_in: number;
  tokens_out: number;
}

function readUsage(): UsageRow[] {
  return getDb()
    .query(
      `SELECT team_bucket, month_key, graphs_run, agents_spawned,
              tokens_in, tokens_out
       FROM orchestration_usage
       ORDER BY team_bucket ASC, month_key ASC`,
    )
    .all() as UsageRow[];
}

describe("runOrchestrateUsageAggregate", () => {
  beforeEach(() => {
    freshDb();
    runCounter = 0;
  });
  afterEach(() => {
    _resetDb();
  });

  it("returns 0 buckets when orchestration_runs is empty", async () => {
    const result = await runOrchestrateUsageAggregate({
      since: new Date("2020-01-01T00:00:00Z"),
    });
    expect(result.bucketsProcessed).toBe(0);
    expect(result.errors).toBe(0);
    expect(readUsage().length).toBe(0);
  });

  it("folds a single run with github_hash into one bucket with graphs_run=1", async () => {
    insertRun({
      identity: hex("alice"),
      githubHash: hex("gh-alice"),
      startedAt: "2026-05-15T10:00:00Z",
      nodeCount: 4,
      tokensIn: 1000,
      tokensOut: 200,
    });

    const result = await runOrchestrateUsageAggregate({
      since: new Date("2020-01-01T00:00:00Z"),
    });
    expect(result.bucketsProcessed).toBe(1);
    expect(result.errors).toBe(0);

    const rows = readUsage();
    expect(rows.length).toBe(1);
    expect(rows[0]!.team_bucket).toBe(hex("gh-alice"));
    expect(rows[0]!.month_key).toBe("2026-05");
    expect(rows[0]!.graphs_run).toBe(1);
    expect(rows[0]!.agents_spawned).toBe(4);
    expect(rows[0]!.tokens_in).toBe(1000);
    expect(rows[0]!.tokens_out).toBe(200);
  });

  it("groups 5 runs across 2 hashes x 2 months into 4 buckets", async () => {
    const a = hex("gh-a");
    const b = hex("gh-b");
    // hash a, month 04 (2 runs)
    insertRun({ identity: hex("ida"), githubHash: a, startedAt: "2026-04-10T09:00:00Z" });
    insertRun({ identity: hex("ida"), githubHash: a, startedAt: "2026-04-20T09:00:00Z" });
    // hash a, month 05 (1 run)
    insertRun({ identity: hex("ida"), githubHash: a, startedAt: "2026-05-01T09:00:00Z" });
    // hash b, month 04 (1 run)
    insertRun({ identity: hex("idb"), githubHash: b, startedAt: "2026-04-12T09:00:00Z" });
    // hash b, month 05 (1 run)
    insertRun({ identity: hex("idb"), githubHash: b, startedAt: "2026-05-12T09:00:00Z" });

    const result = await runOrchestrateUsageAggregate({
      since: new Date("2020-01-01T00:00:00Z"),
    });
    expect(result.bucketsProcessed).toBe(4);

    const rows = readUsage();
    expect(rows.length).toBe(4);

    // Lookup by composite key.
    const lookup = new Map(rows.map((r) => [`${r.team_bucket}|${r.month_key}`, r]));
    expect(lookup.get(`${a}|2026-04`)!.graphs_run).toBe(2);
    expect(lookup.get(`${a}|2026-05`)!.graphs_run).toBe(1);
    expect(lookup.get(`${b}|2026-04`)!.graphs_run).toBe(1);
    expect(lookup.get(`${b}|2026-05`)!.graphs_run).toBe(1);
  });

  it("excludes anonymous runs (github_hash NULL) from team buckets", async () => {
    // Two anonymous runs (NULL github_hash) — must NOT produce buckets.
    insertRun({
      identity: hex("anon1"),
      githubHash: null,
      startedAt: "2026-05-10T09:00:00Z",
    });
    insertRun({
      identity: hex("anon2"),
      githubHash: null,
      startedAt: "2026-05-11T09:00:00Z",
    });
    // One logged-in run — must produce exactly one bucket.
    insertRun({
      identity: hex("idc"),
      githubHash: hex("gh-c"),
      startedAt: "2026-05-12T09:00:00Z",
    });

    const result = await runOrchestrateUsageAggregate({
      since: new Date("2020-01-01T00:00:00Z"),
    });
    expect(result.bucketsProcessed).toBe(1);

    const rows = readUsage();
    expect(rows.length).toBe(1);
    expect(rows[0]!.team_bucket).toBe(hex("gh-c"));
    expect(rows[0]!.graphs_run).toBe(1);
    // No bucket exists for anonymous identities — confirm via direct query.
    const anonCheck = getDb()
      .query(`SELECT COUNT(*) AS n FROM orchestration_usage WHERE team_bucket IS NULL`)
      .get() as { n: number };
    expect(anonCheck.n).toBe(0);
  });

  it("is idempotent — re-running produces stable counts", async () => {
    const a = hex("gh-a");
    insertRun({
      identity: hex("ida"),
      githubHash: a,
      startedAt: "2026-05-10T09:00:00Z",
      nodeCount: 2,
      tokensIn: 500,
      tokensOut: 100,
    });
    insertRun({
      identity: hex("ida"),
      githubHash: a,
      startedAt: "2026-05-11T09:00:00Z",
      nodeCount: 3,
      tokensIn: 700,
      tokensOut: 150,
    });

    await runOrchestrateUsageAggregate({ since: new Date("2020-01-01T00:00:00Z") });
    const first = readUsage();
    await runOrchestrateUsageAggregate({ since: new Date("2020-01-01T00:00:00Z") });
    const second = readUsage();

    expect(second.length).toBe(first.length);
    expect(second.length).toBe(1);
    expect(second[0]!.graphs_run).toBe(first[0]!.graphs_run);
    expect(second[0]!.graphs_run).toBe(2);
    expect(second[0]!.agents_spawned).toBe(5);
    expect(second[0]!.tokens_in).toBe(1200);
    expect(second[0]!.tokens_out).toBe(250);
  });

  it("sums agents_spawned + tokens correctly across multiple runs", async () => {
    const a = hex("gh-sum");
    // 3 runs in the same month, same hash — should fold into one bucket
    // with summed agents_spawned and tokens.
    insertRun({
      identity: hex("id"), githubHash: a,
      startedAt: "2026-05-01T10:00:00Z",
      nodeCount: 2, tokensIn: 100, tokensOut: 20,
    });
    insertRun({
      identity: hex("id"), githubHash: a,
      startedAt: "2026-05-02T10:00:00Z",
      nodeCount: 4, tokensIn: 300, tokensOut: 50,
    });
    insertRun({
      identity: hex("id"), githubHash: a,
      startedAt: "2026-05-03T10:00:00Z",
      nodeCount: 7, tokensIn: 1500, tokensOut: 400,
    });

    await runOrchestrateUsageAggregate({ since: new Date("2020-01-01T00:00:00Z") });
    const rows = readUsage();
    expect(rows.length).toBe(1);
    expect(rows[0]!.graphs_run).toBe(3);
    expect(rows[0]!.agents_spawned).toBe(13);  // 2+4+7
    expect(rows[0]!.tokens_in).toBe(1900);     // 100+300+1500
    expect(rows[0]!.tokens_out).toBe(470);     // 20+50+400
  });
});
