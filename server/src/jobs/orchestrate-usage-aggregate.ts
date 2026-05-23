/**
 * orchestrate-usage-aggregate.ts — Central token-quota accounting rollup.
 *
 * Folds orchestration_runs rows into orchestration_usage by
 * (team_bucket, month_key) where team_bucket = github_hash. The executor
 * (cloud orchestration, wk 7-12) reads percent_of_cap from this table at
 * run time to enforce the per-seat monthly cap of 200 graph-runs.
 *
 * Invoked from daily-wad-d-aggregate.ts after the WAD-D snapshot upsert and
 * the discovery-propagation rollup. A failure here is best-effort and MUST
 * NOT fail the daily WAD-D rollup.
 *
 * Privacy:
 *   - team_bucket is already-salted github_hash (never raw login).
 *   - Anonymous runs (github_hash NULL) are EXCLUDED from team buckets —
 *     only logged-in developers count toward the cap.
 *   - Error paths log at most github_hash.slice(0, 6) so a stray log line
 *     never leaks the full hash.
 *
 * Idempotency: ON CONFLICT(team_bucket, month_key) upsert. Re-running over
 * the same window produces stable counts.
 *
 * Hard 5-second wallclock budget. Q1'27 cohorts are small (low hundreds of
 * buckets per month) so this should complete in well under that envelope.
 */

import { Database } from "bun:sqlite";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wallclock budget — guarded inside the scan loop. */
const BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunOptions {
  /**
   * Lower bound on orchestration_runs.started_at. Defaults to the first day
   * of the current UTC month (so we only refresh the live month by default).
   */
  since?: Date;
  /** Optional injected DB (test path). Defaults to getDb(). */
  db?: Database;
}

export interface RunResult {
  /** Number of distinct (team_bucket, month_key) rows upserted. */
  bucketsProcessed: number;
  /** Number of source rows that could not be folded (always 0 today — the
   *  SQL filter excludes NULL github_hash; reserved for future per-row
   *  validation failures). */
  errors: number;
}

interface BucketRow {
  github_hash: string;
  month_key: string;
  graphs_run: number;
  agents_spawned: number;
  tokens_in: number;
  tokens_out: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First day of the current UTC month as an ISO timestamp. */
function firstOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Aggregate orchestration_runs into orchestration_usage by
 * (github_hash, YYYY-MM).
 *
 * Anonymous runs (github_hash NULL) are excluded — they have no team to
 * bucket against. This is deliberate: the central-quota model only governs
 * logged-in seats.
 */
export async function runOrchestrateUsageAggregate(
  opts: RunOptions = {},
): Promise<RunResult> {
  const startedMs = Date.now();
  const db = opts.db ?? getDb();
  const since = opts.since ?? firstOfCurrentMonthUtc();
  const sinceIso = since.toISOString();

  let bucketsProcessed = 0;
  let errors = 0;

  try {
    // SQLite groups everything for us in a single scan — github_hash is
    // indexed via idx_orch_runs_identity (covers the GROUP BY for small
    // tables; for larger tables we'd add a dedicated index, but Q1'27
    // cohorts are too small to justify another index right now).
    //
    // We exclude NULL github_hash rows. strftime works because started_at
    // is an ISO timestamp string in our writer; SQLite parses it lexically.
    const rows = db
      .query<BucketRow, [string]>(
        `SELECT
           github_hash                              AS github_hash,
           strftime('%Y-%m', started_at)            AS month_key,
           COUNT(*)                                 AS graphs_run,
           COALESCE(SUM(node_count), 0)             AS agents_spawned,
           COALESCE(SUM(total_tokens_in), 0)        AS tokens_in,
           COALESCE(SUM(total_tokens_out), 0)       AS tokens_out
         FROM orchestration_runs
         WHERE started_at >= ?
           AND github_hash IS NOT NULL
         GROUP BY github_hash, strftime('%Y-%m', started_at)`,
      )
      .all(sinceIso);

    if (rows.length === 0) {
      return { bucketsProcessed: 0, errors: 0 };
    }

    const upsert = db.prepare(
      `INSERT INTO orchestration_usage
         (team_bucket, month_key, graphs_run, agents_spawned,
          tokens_in, tokens_out, last_aggregated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(team_bucket, month_key) DO UPDATE SET
         graphs_run         = excluded.graphs_run,
         agents_spawned     = excluded.agents_spawned,
         tokens_in          = excluded.tokens_in,
         tokens_out         = excluded.tokens_out,
         last_aggregated_at = excluded.last_aggregated_at`,
    );

    const tx = db.transaction(() => {
      for (const row of rows) {
        // Hard wallclock cutoff. Whatever we've folded so far is still
        // safe to upsert — partial progress is better than zero progress.
        if (Date.now() - startedMs > BUDGET_MS) {
          logger.warn(
            { event: "orchestrate_usage_budget", processedSoFar: bucketsProcessed },
            "orchestrate-usage-aggregate: wallclock budget exceeded — committing partial result",
          );
          break;
        }
        try {
          upsert.run(
            row.github_hash,
            row.month_key,
            row.graphs_run,
            row.agents_spawned,
            row.tokens_in,
            row.tokens_out,
          );
          bucketsProcessed += 1;
        } catch (err) {
          // Privacy: only log a 6-char prefix of the bucket key on error.
          errors += 1;
          logger.warn(
            {
              event: "orchestrate_usage_upsert_failed",
              bucket_prefix: row.github_hash.slice(0, 6),
              month_key: row.month_key,
              err: err instanceof Error ? err.message : String(err),
            },
            "orchestrate-usage-aggregate: upsert failed for bucket",
          );
        }
      }
    });
    tx();
  } catch (err) {
    logger.error(
      {
        event: "orchestrate_usage_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "orchestrate-usage-aggregate: scan failed",
    );
    throw err;
  }

  return { bucketsProcessed, errors };
}
