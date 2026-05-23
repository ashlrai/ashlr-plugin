#!/usr/bin/env bun
/**
 * daily-wad-d-aggregate.ts — WAD-D snapshot computer.
 *
 * Invocation:
 *   bun server/src/jobs/daily-wad-d-aggregate.ts            # run for today (UTC)
 *   bun server/src/jobs/daily-wad-d-aggregate.ts --date YYYY-MM-DD
 *   bun server/src/jobs/daily-wad-d-aggregate.ts --dry-run
 *
 * Scheduling: invoke daily at 02:00 UTC. Recommended cron:
 *   Render Cron:        0 2 * * *
 *   GitHub Actions:     schedule: [{ cron: "0 2 * * *" }]
 *   Manual:             bun server/src/jobs/daily-wad-d-aggregate.ts
 *
 * The export `runDailyWadDAggregate(opts)` is reused by the integration test.
 *
 * WAD-D definition (Weekly Active Developers — Daily):
 *   For a given snapshot_date D, count how many distinct identity_hash values
 *   have at least N (default 5) distinct active_date entries inside the
 *   rolling 7-day window ending at D (inclusive). An identity that pinged
 *   >= 5 of the last 7 days is "active". WAD-D = count of such identities.
 *
 *   Identities are first de-duplicated by github_hash when present (so one
 *   developer with multiple machines counts once); machine-only identities
 *   without a github_hash are counted by identity_hash directly.
 *
 * Privacy: snapshot rows never carry any identity data — only the aggregate
 * counter and the JSON-encoded lead indicators. Founder-only by convention.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD_DAYS = 5; // >= this many distinct days = "active"
const WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WadDLeadIndicators {
  /** Distinct identities seen at all in the 7-day window. */
  identities_seen: number;
  /** Identities seen >= 1 day in window. */
  identities_1d_plus: number;
  /** Identities seen >= 3 days in window. */
  identities_3d_plus: number;
  /** Identities seen >= 5 days in window (== WAD-D, sanity check). */
  identities_5d_plus: number;
  /** Identities seen 7/7 days (power users). */
  identities_7d_plus: number;
  /** Median distinct-day count per identity in window. */
  median_active_days: number;
  /**
   * TODO: client-side instrumentation needed for genuine "lead indicators"
   * (e.g. tools-per-session, savings-per-day). Stubbed to 0 below until the
   * client emits them through the daily heartbeat.
   */
  client_instrumentation_pending: number;
}

export interface RunOptions {
  /** UTC date to snapshot for. Defaults to today UTC. */
  snapshotDate?: string;
  /** Distinct-day threshold. Defaults to 5. */
  thresholdDays?: number;
  /** When true: compute and log but DO NOT write the snapshot. */
  dryRun?: boolean;
  /** Optional injected DB (test path). Defaults to getDb(). */
  db?: Database;
}

export interface RunResult {
  snapshot_date: string;
  wad_d_value: number;
  lead_indicators: WadDLeadIndicators;
  written: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayUtc(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function isoDateNDaysBefore(dateStr: string, n: number): string {
  // Parse YYYY-MM-DD as midnight UTC, then subtract n days.
  const base = new Date(`${dateStr}T00:00:00Z`).getTime();
  const earlier = new Date(base - n * 86_400_000);
  return earlier.toISOString().slice(0, 10);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Compute the WAD-D snapshot for a UTC date and optionally write it.
 *
 * Algorithm:
 *   1. Window = (snapshotDate - 6) ... snapshotDate inclusive (7 days).
 *   2. Group by COALESCE(github_hash, identity_hash) so multi-machine devs
 *      get folded into one identity.
 *   3. Count distinct active_date per identity.
 *   4. WAD-D = identities with count >= thresholdDays.
 */
export function runDailyWadDAggregate(opts: RunOptions = {}): RunResult {
  const db = opts.db ?? getDb();
  const snapshotDate = opts.snapshotDate ?? todayUtc();
  const thresholdDays = opts.thresholdDays ?? DEFAULT_THRESHOLD_DAYS;
  const windowStart = isoDateNDaysBefore(snapshotDate, WINDOW_DAYS - 1);

  // Per-identity distinct-day counts inside the window.
  // COALESCE(github_hash, identity_hash) folds machines per developer.
  const rows = db
    .query<{ active_days: number }, [string, string]>(
      `SELECT COUNT(DISTINCT active_date) AS active_days
       FROM daily_active_records
       WHERE active_date >= ? AND active_date <= ?
       GROUP BY COALESCE(github_hash, identity_hash)`,
    )
    .all(windowStart, snapshotDate);

  const counts = rows.map((r) => r.active_days);

  const indicators: WadDLeadIndicators = {
    identities_seen:    counts.length,
    identities_1d_plus: counts.filter((c) => c >= 1).length,
    identities_3d_plus: counts.filter((c) => c >= 3).length,
    identities_5d_plus: counts.filter((c) => c >= 5).length,
    identities_7d_plus: counts.filter((c) => c >= 7).length,
    median_active_days: median(counts),
    // TODO: requires richer client-side instrumentation in the daily heartbeat
    // payload (tools-per-session, savings-per-day). Stubbed at 0.
    client_instrumentation_pending: 0,
  };

  const wadD = counts.filter((c) => c >= thresholdDays).length;

  if (!opts.dryRun) {
    db.run(
      `INSERT INTO wad_d_snapshots
         (snapshot_date, wad_d_value, lead_indicators_json)
       VALUES (?, ?, ?)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         wad_d_value          = excluded.wad_d_value,
         lead_indicators_json = excluded.lead_indicators_json,
         computed_at          = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      [snapshotDate, wadD, JSON.stringify(indicators)],
    );
  }

  return {
    snapshot_date: snapshotDate,
    wad_d_value: wadD,
    lead_indicators: indicators,
    written: !opts.dryRun,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Exported for test coverage of CLI flag handling.
export function parseCliArgs(argv: string[]): {
  dryRun: boolean;
  snapshotDate: string;
  dbPath: string | null;
} {
  const dryRun = argv.includes("--dry-run");

  const dateIdx = argv.indexOf("--date");
  let snapshotDate = todayUtc();
  if (dateIdx !== -1) {
    const candidate = argv[dateIdx + 1];
    if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
      throw new Error(
        `--date requires a YYYY-MM-DD argument (got: ${JSON.stringify(candidate)})`,
      );
    }
    snapshotDate = candidate;
  }

  const dbFlagIdx = argv.indexOf("--db");
  const dbPath =
    dbFlagIdx !== -1 && argv[dbFlagIdx + 1]
      ? argv[dbFlagIdx + 1]!
      : (process.env["ASHLR_DB_PATH"] ?? null);

  return { dryRun, snapshotDate, dbPath };
}

if (import.meta.main) {
  const startMs = Date.now();
  try {
    const { dryRun, snapshotDate, dbPath } = parseCliArgs(process.argv.slice(2));

    logger.info(
      { event: "cron_start", job: "daily-wad-d-aggregate", snapshotDate, dryRun },
      "daily-wad-d-aggregate: cron_start",
    );

    const db = dbPath ? new Database(dbPath, { create: true }) : undefined;
    // Default: use the server's getDb() singleton via runDailyWadDAggregate.

    const result = runDailyWadDAggregate({
      snapshotDate,
      dryRun,
      ...(db ? { db } : {}),
    });

    const durationMs = Date.now() - startMs;
    logger.info(
      {
        event: "cron_end",
        job: "daily-wad-d-aggregate",
        snapshot_date: result.snapshot_date,
        wad_d_value: result.wad_d_value,
        lead_indicators: result.lead_indicators,
        written: result.written,
        durationMs,
        ok: true,
      },
      dryRun
        ? "daily-wad-d-aggregate: cron_end (dry-run)"
        : "daily-wad-d-aggregate: cron_end",
    );
    process.exit(0);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    logger.error(
      {
        event: "cron_end",
        job: "daily-wad-d-aggregate",
        durationMs,
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      },
      "daily-wad-d-aggregate: cron_end (failed)",
    );
    process.exit(1);
  }
}

// Silence unused-import warnings in non-CLI builds.
void join;
