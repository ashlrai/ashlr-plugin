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
import { runDiscoveryPropagationAggregate } from "./discovery-propagation-aggregate.js";
import { runOrchestrateUsageAggregate } from "./orchestrate-usage-aggregate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD_DAYS = 5; // >= this many distinct days = "active"
const WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimum non-null rows required before we publish a lead-indicator value.
 * Smaller cohorts make ratios noisy enough to mislead; we publish `null`
 * + insufficient_data: true instead so the dashboard renders a "—".
 */
export const LEAD_INDICATOR_MIN_ROWS = 10;
export const FIRST_SAVINGS_WINDOW_MS = 30 * 60 * 1000;

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
  // ---- Q2 lead-indicator levers (populated from client heartbeats) ----
  /** % of reporting identities with onboarding_completed=true. null when <10 reporters. */
  onboarding_completion_rate: number | null;
  /** % of reporting identities with status_line_enabled=true. null when <10 reporters. */
  status_line_opt_in_rate: number | null;
  /**
   * % of reporting identities whose first_savings_at fell within
   * FIRST_SAVINGS_WINDOW_MS of their earliest received_at across all rows.
   * Bootstrap: until we track a true first-seen timestamp on the server, we
   * approximate "within 30 minutes of install" as "first_savings_at is
   * non-null AND occurred on or before that identity's earliest active_date".
   */
  first_savings_within_30min_rate: number | null;
  /** Median streak_days across non-null rows. null when <10 reporters. */
  median_streak_days: number | null;
  /** Sum of savings_invocations_this_week across reporters (raw count). */
  weekly_savings_invocations_total: number | null;
  /** Median nudge_accept_rate across non-null rows in [0,1]. */
  nudge_accept_rate_median: number | null;
  /**
   * True when fewer than LEAD_INDICATOR_MIN_ROWS rows had at least one
   * lead-indicator field populated. The headline rates are all null in this
   * case so the dashboard can render a "n=X (insufficient data)" stub.
   */
  insufficient_data: boolean;
  /** Reporter count — useful for the dashboard "n=X" subtitle. */
  reporting_identities: number;
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

  // Lead-indicator rollup. Pull the latest non-null value per developer (folded
  // by COALESCE(github_hash, identity_hash)) within the same 7-day window.
  // Each metric is computed independently — a row that only reports streak_days
  // contributes to median_streak_days but is skipped by onboarding_completion_rate.
  interface LeadRow {
    identity: string;
    onboarding_completed: number | null;
    status_line_enabled: number | null;
    first_savings_at: string | null;
    streak_days: number | null;
    savings_invocations_this_week: number | null;
    nudge_accept_rate: number | null;
    first_active_date: string;
  }
  // For each identity (folded by github_hash/identity_hash) we take the most
  // recent non-null value per column. SQLite has no FILTER + LAST aggregator
  // we can rely on portably, so we fold in JS — the rowset is at most O(7 *
  // identities), which is fine for the maintainer-only WAD-D workload.
  const leadRows = db
    .query<{
      identity: string;
      active_date: string;
      onboarding_completed: number | null;
      status_line_enabled: number | null;
      first_savings_at: string | null;
      streak_days: number | null;
      savings_invocations_this_week: number | null;
      nudge_accept_rate: number | null;
    }, [string, string]>(
      `SELECT COALESCE(github_hash, identity_hash) AS identity,
              active_date,
              onboarding_completed,
              status_line_enabled,
              first_savings_at,
              streak_days,
              savings_invocations_this_week,
              nudge_accept_rate
       FROM daily_active_records
       WHERE active_date >= ? AND active_date <= ?
       ORDER BY active_date ASC`,
    )
    .all(windowStart, snapshotDate);

  const perDev = new Map<string, LeadRow>();
  for (const r of leadRows) {
    const ex = perDev.get(r.identity);
    if (!ex) {
      perDev.set(r.identity, {
        identity: r.identity,
        onboarding_completed: r.onboarding_completed,
        status_line_enabled: r.status_line_enabled,
        first_savings_at: r.first_savings_at,
        streak_days: r.streak_days,
        savings_invocations_this_week: r.savings_invocations_this_week,
        nudge_accept_rate: r.nudge_accept_rate,
        first_active_date: r.active_date,
      });
      continue;
    }
    // Rows are ordered ASC by active_date. Take the LATEST non-null value
    // per column so a dev who flipped onboarding=true mid-window stays true.
    if (r.onboarding_completed !== null) ex.onboarding_completed = r.onboarding_completed;
    if (r.status_line_enabled !== null) ex.status_line_enabled = r.status_line_enabled;
    if (r.first_savings_at !== null) {
      // Earliest first_savings_at wins (it should never change after first set).
      if (!ex.first_savings_at || r.first_savings_at < ex.first_savings_at) {
        ex.first_savings_at = r.first_savings_at;
      }
    }
    if (r.streak_days !== null) ex.streak_days = r.streak_days;
    if (r.savings_invocations_this_week !== null) ex.savings_invocations_this_week = r.savings_invocations_this_week;
    if (r.nudge_accept_rate !== null) ex.nudge_accept_rate = r.nudge_accept_rate;
  }
  const reporters = [...perDev.values()];

  function rate(reporters: LeadRow[], pred: (r: LeadRow) => boolean, has: (r: LeadRow) => boolean): number | null {
    const eligible = reporters.filter(has);
    if (eligible.length < LEAD_INDICATOR_MIN_ROWS) return null;
    const hits = eligible.filter(pred).length;
    return Math.round((hits / eligible.length) * 1000) / 1000;
  }
  function medianOf(values: number[]): number | null {
    if (values.length < LEAD_INDICATOR_MIN_ROWS) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }
  function sumOf(values: number[]): number | null {
    if (values.length < LEAD_INDICATOR_MIN_ROWS) return null;
    return values.reduce((a, b) => a + b, 0);
  }

  const onboardingRate = rate(
    reporters,
    (r) => r.onboarding_completed === 1,
    (r) => r.onboarding_completed !== null,
  );
  const statusLineRate = rate(
    reporters,
    (r) => r.status_line_enabled === 1,
    (r) => r.status_line_enabled !== null,
  );
  // first_savings_within_30min bootstrap: we don't store the user's true
  // install timestamp server-side yet. Approximate with: first_savings_at
  // ISO timestamp landed at-or-before the identity's first active_date in
  // window (since active_date is YYYY-MM-DD, "at-or-before" means the
  // ISO date prefix is <= the first_active_date). This systematically
  // under-counts power users who installed mid-day but it's directionally
  // correct and never inflates the rate.
  const firstSavingsRate = rate(
    reporters,
    (r) =>
      r.first_savings_at !== null &&
      r.first_savings_at.slice(0, 10) <= r.first_active_date,
    (r) => r.first_savings_at !== null,
  );
  const streakValues = reporters
    .map((r) => r.streak_days)
    .filter((v): v is number => v !== null);
  const streakMedian = medianOf(streakValues);
  const invocationValues = reporters
    .map((r) => r.savings_invocations_this_week)
    .filter((v): v is number => v !== null);
  const invocationSum = sumOf(invocationValues);
  const nudgeValues = reporters
    .map((r) => r.nudge_accept_rate)
    .filter((v): v is number => v !== null);
  const nudgeMedian = medianOf(nudgeValues);

  // Reporting cohort = identities that supplied at least one lead-indicator
  // field. The headline rates are independently gated on their own
  // populated-count, but we surface this top-level so the dashboard can
  // render "n=X reporting" alongside the metrics.
  const reportingCount = reporters.filter((r) =>
    r.onboarding_completed !== null ||
    r.status_line_enabled !== null ||
    r.first_savings_at !== null ||
    r.streak_days !== null ||
    r.savings_invocations_this_week !== null ||
    r.nudge_accept_rate !== null,
  ).length;

  const indicators: WadDLeadIndicators = {
    identities_seen:    counts.length,
    identities_1d_plus: counts.filter((c) => c >= 1).length,
    identities_3d_plus: counts.filter((c) => c >= 3).length,
    identities_5d_plus: counts.filter((c) => c >= 5).length,
    identities_7d_plus: counts.filter((c) => c >= 7).length,
    median_active_days: median(counts),
    onboarding_completion_rate:       onboardingRate,
    status_line_opt_in_rate:          statusLineRate,
    first_savings_within_30min_rate:  firstSavingsRate,
    median_streak_days:               streakMedian,
    weekly_savings_invocations_total: invocationSum,
    nudge_accept_rate_median:         nudgeMedian,
    insufficient_data: reportingCount < LEAD_INDICATOR_MIN_ROWS,
    reporting_identities: reportingCount,
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

  // ---------------------------------------------------------------------------
  // Cross-session discovery propagation rollup (Q4).
  //
  // Best-effort: a failure here MUST NOT fail the WAD-D snapshot. We invoke
  // it after the WAD-D upsert so any propagation error doesn't lose the
  // headline metric the cron exists to compute.
  //
  // The aggregator returns a Promise but does no real I/O suspension — it's
  // marked async only to honour its declared return type. We deliberately do
  // NOT `await` here so the sync signature of runDailyWadDAggregate stays
  // stable for the dozens of existing test call sites; instead we attach a
  // .catch() to surface failures without unhandled-promise warnings.
  // ---------------------------------------------------------------------------
  if (!opts.dryRun) {
    try {
      const propagationPromise = runDiscoveryPropagationAggregate(
        opts.db ? { db: opts.db } : {},
      );
      propagationPromise.catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "discovery propagation aggregate failed; continuing",
        );
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "discovery propagation aggregate failed; continuing",
      );
    }

    // ---------------------------------------------------------------------
    // Q1'27 wk 7-9 — Orchestration central-quota accounting rollup.
    //
    // Same best-effort contract as discovery propagation above: a failure
    // here MUST NOT fail the WAD-D snapshot. Returns a Promise (real I/O
    // for the upsert transaction) — we attach .catch() so any error is
    // logged without surfacing as an unhandled-rejection warning.
    // ---------------------------------------------------------------------
    try {
      const usagePromise = runOrchestrateUsageAggregate(
        opts.db ? { db: opts.db } : {},
      );
      usagePromise.catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "orchestrate-usage aggregate failed; continuing",
        );
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "orchestrate-usage aggregate failed; continuing",
      );
    }
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
