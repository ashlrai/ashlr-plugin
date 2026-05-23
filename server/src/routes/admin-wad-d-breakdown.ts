/**
 * admin-wad-d-breakdown.ts — Q4 Multiplayer DNA: per-segment WAD-D breakdown.
 *
 * Sibling to admin-wad-d.ts (which returns raw snapshot history). This route
 * computes a derived view: per-segment WAD-D and lead-indicator rollups for
 * the last N days, plus week-over-week movers, federated into a single
 * payload the founder dashboard can render in one round trip.
 *
 * Endpoint:
 *   GET /admin/wad-d-breakdown?days=N
 *     Auth:    Authorization: Bearer <ASHLR_ADMIN_TRIGGER_TOKEN>
 *     Query:   days — integer, default 30, capped at 365
 *     200:     {
 *                window: { days, from, to },
 *                totals: { wad_d, identities_seen, ...rates },
 *                segments: {
 *                  logged_in: {...},   // rows with non-null github_hash
 *                  anonymous: {...},   // rows with null github_hash
 *                },
 *                top_lead_indicators_movers: [{indicator, current, prev, delta}],
 *              }
 *     401:     missing/wrong bearer
 *     503:     ASHLR_ADMIN_TRIGGER_TOKEN unset on server
 *
 * Segment definition (v0):
 *   "Team" is loose — we have no formal org/team table yet. For this PR we
 *   bucket by github_hash presence:
 *     - logged_in : github_hash IS NOT NULL (folded by github_hash so multi-
 *                   machine developers count once per segment)
 *     - anonymous : github_hash IS NULL (folded by identity_hash)
 *   When the schema grows a real team/org table, swap the segmentation
 *   predicate without changing the response shape.
 *
 * Privacy: identity_hash / github_hash never leave this server — only the
 * aggregate counters and rates are serialized.
 *
 * WAD-D per segment uses the standard >=5-of-7-days rule, computed for the
 * 7-day window ending at the `to` date (i.e. the snapshot day). Lead-
 * indicator rates are computed over the full N-day window (one latest non-
 * null value per identity per indicator).
 *
 * Week-over-week movers compare the latest-7-days window vs the prior-7-days
 * window and return the 3 indicators with the largest absolute delta.
 */

import { Hono } from "hono";
import { timingSafeEqual, randomUUID } from "crypto";
import { Buffer } from "buffer";
import { logger } from "../lib/logger.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Dependency injection seam for testing
// ---------------------------------------------------------------------------
//
// Mirrors admin-wad-d.ts: tests inject a fake reader that returns a fixture
// row set so we can verify aggregation without seeding a real schema.
// ---------------------------------------------------------------------------

export interface DailyActiveRow {
  identity_hash: string;
  github_hash: string | null;
  active_date: string;
  onboarding_completed: number | null;
  status_line_enabled: number | null;
  first_savings_at: string | null;
  streak_days: number | null;
  savings_invocations_this_week: number | null;
  nudge_accept_rate: number | null;
}

type ReadRows = (from: string, to: string) => DailyActiveRow[] | Promise<DailyActiveRow[]>;

function defaultReadRows(from: string, to: string): DailyActiveRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT identity_hash, github_hash, active_date,
              onboarding_completed, status_line_enabled,
              first_savings_at, streak_days,
              savings_invocations_this_week, nudge_accept_rate
       FROM daily_active_records
       WHERE active_date >= ? AND active_date <= ?`,
    )
    .all(from, to) as DailyActiveRow[];
}

let activeReader: ReadRows = defaultReadRows;

/** @internal — test-only hook. Do not call from production code. */
export function _setWadDBreakdownReader(fn: ReadRows | null): void {
  activeReader = fn ?? defaultReadRows;
}

const adminWadDBreakdown = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const WAD_D_THRESHOLD_DAYS = 5; // >= 5 of 7 = active
const WAD_D_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeCompareBearer(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function parseDaysParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDateNDaysBefore(dateStr: string, n: number): string {
  const base = new Date(`${dateStr}T00:00:00Z`).getTime();
  const earlier = new Date(base - n * 86_400_000);
  return earlier.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface SegmentRollup {
  wad_d: number;
  identities_seen: number;
  onboarding_completion_rate: number | null;
  status_line_opt_in_rate: number | null;
  median_streak_days: number | null;
  nudge_accept_rate_median: number | null;
  reporting_identities: number;
}

interface PerIdentityFold {
  identity: string;
  active_dates: Set<string>;
  onboarding_completed: number | null;
  status_line_enabled: number | null;
  streak_days: number | null;
  nudge_accept_rate: number | null;
}

/**
 * Fold raw rows into per-identity records, using the supplied key extractor
 * so callers can pick "github_hash only", "identity_hash only", or
 * "COALESCE(github_hash, identity_hash)" semantics without re-querying.
 *
 * Returns null when no rows match — caller decides empty-segment shape.
 */
function foldByIdentity(
  rows: DailyActiveRow[],
  keyOf: (r: DailyActiveRow) => string | null,
): PerIdentityFold[] {
  const map = new Map<string, PerIdentityFold>();
  // Sort ASC so the "latest non-null wins" pass below is deterministic.
  const sorted = [...rows].sort((a, b) => a.active_date.localeCompare(b.active_date));
  for (const r of sorted) {
    const key = keyOf(r);
    if (key === null) continue;
    let f = map.get(key);
    if (!f) {
      f = {
        identity: key,
        active_dates: new Set<string>(),
        onboarding_completed: null,
        status_line_enabled: null,
        streak_days: null,
        nudge_accept_rate: null,
      };
      map.set(key, f);
    }
    f.active_dates.add(r.active_date);
    if (r.onboarding_completed !== null) f.onboarding_completed = r.onboarding_completed;
    if (r.status_line_enabled !== null) f.status_line_enabled = r.status_line_enabled;
    if (r.streak_days !== null) f.streak_days = r.streak_days;
    if (r.nudge_accept_rate !== null) f.nudge_accept_rate = r.nudge_accept_rate;
  }
  return [...map.values()];
}

function rateOf(folds: PerIdentityFold[], pred: (f: PerIdentityFold) => boolean, has: (f: PerIdentityFold) => boolean): number | null {
  const eligible = folds.filter(has);
  if (eligible.length === 0) return null;
  const hits = eligible.filter(pred).length;
  return Math.round((hits / eligible.length) * 1000) / 1000;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 1000) / 1000
    : sorted[mid]!;
}

/**
 * Compute a segment's headline numbers. WAD-D is restricted to the last
 * 7 days of the supplied row set so it matches the standard definition
 * even when `days` (the dashboard window) is larger.
 */
function rollupSegment(
  folds: PerIdentityFold[],
  wadDWindowStart: string,
): SegmentRollup {
  const identitiesSeen = folds.length;
  const wadD = folds.filter((f) => {
    let n = 0;
    for (const d of f.active_dates) {
      if (d >= wadDWindowStart) n += 1;
    }
    return n >= WAD_D_THRESHOLD_DAYS;
  }).length;

  const onboardingRate = rateOf(
    folds,
    (f) => f.onboarding_completed === 1,
    (f) => f.onboarding_completed !== null,
  );
  const statusLineRate = rateOf(
    folds,
    (f) => f.status_line_enabled === 1,
    (f) => f.status_line_enabled !== null,
  );
  const streakValues = folds
    .map((f) => f.streak_days)
    .filter((v): v is number => v !== null);
  const nudgeValues = folds
    .map((f) => f.nudge_accept_rate)
    .filter((v): v is number => v !== null);

  const reportingIdentities = folds.filter((f) =>
    f.onboarding_completed !== null ||
    f.status_line_enabled !== null ||
    f.streak_days !== null ||
    f.nudge_accept_rate !== null,
  ).length;

  return {
    wad_d: wadD,
    identities_seen: identitiesSeen,
    onboarding_completion_rate: onboardingRate,
    status_line_opt_in_rate: statusLineRate,
    median_streak_days: medianOf(streakValues),
    nudge_accept_rate_median: medianOf(nudgeValues),
    reporting_identities: reportingIdentities,
  };
}

export interface MoverEntry {
  indicator: string;
  current: number | null;
  prev: number | null;
  delta: number | null;
}

/**
 * Compute week-over-week movers across totals only (segments would multiply
 * noise without adding signal at small cohorts). Returns up to 3 entries
 * sorted by |delta| desc; entries with both sides null are skipped.
 */
function computeMovers(
  currentRollup: SegmentRollup,
  prevRollup: SegmentRollup,
): MoverEntry[] {
  const candidates: Array<{ key: keyof SegmentRollup; label: string }> = [
    { key: "onboarding_completion_rate", label: "onboarding_completion_rate" },
    { key: "status_line_opt_in_rate", label: "status_line_opt_in_rate" },
    { key: "median_streak_days", label: "median_streak_days" },
    { key: "nudge_accept_rate_median", label: "nudge_accept_rate_median" },
  ];

  const entries: MoverEntry[] = [];
  for (const { key, label } of candidates) {
    const cur = currentRollup[key] as number | null;
    const prev = prevRollup[key] as number | null;
    if (cur === null && prev === null) continue;
    const delta = cur !== null && prev !== null
      ? Math.round((cur - prev) * 1000) / 1000
      : null;
    entries.push({ indicator: label, current: cur, prev, delta });
  }
  // Sort: defined deltas first (by |delta| desc), then null deltas last.
  entries.sort((a, b) => {
    const aDef = a.delta !== null ? 1 : 0;
    const bDef = b.delta !== null ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;
    if (a.delta !== null && b.delta !== null) {
      return Math.abs(b.delta) - Math.abs(a.delta);
    }
    return 0;
  });
  return entries.slice(0, 3);
}

// ---------------------------------------------------------------------------
// GET /admin/wad-d-breakdown
// ---------------------------------------------------------------------------

adminWadDBreakdown.get("/admin/wad-d-breakdown", async (c) => {
  const requestId = randomUUID();
  const expected = process.env["ASHLR_ADMIN_TRIGGER_TOKEN"];

  if (!expected) {
    logger.warn(
      { event: "admin_wad_d_breakdown", requestId, reason: "token_unset" },
      "admin-wad-d-breakdown: rejected (ASHLR_ADMIN_TRIGGER_TOKEN unset)",
    );
    return c.json(
      { error: "Endpoint disabled (admin trigger token not configured)", requestId },
      503,
    );
  }

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!safeCompareBearer(provided, expected)) {
    return c.json({ error: "Unauthorized", requestId }, 401);
  }

  const days = parseDaysParam(c.req.query("days"));
  const to = todayUtc();
  const from = isoDateNDaysBefore(to, days - 1);
  const wadDStart = isoDateNDaysBefore(to, WAD_D_WINDOW_DAYS - 1);
  const prevTo = isoDateNDaysBefore(to, WAD_D_WINDOW_DAYS);
  const prevFrom = isoDateNDaysBefore(prevTo, WAD_D_WINDOW_DAYS - 1);

  try {
    const rows = await activeReader(from, to);
    const prevRows = await activeReader(prevFrom, prevTo);

    // Total rollup folds by COALESCE(github_hash, identity_hash) — matches
    // the canonical WAD-D aggregator in jobs/daily-wad-d-aggregate.ts.
    const totalFolds = foldByIdentity(
      rows,
      (r) => r.github_hash ?? r.identity_hash,
    );
    const loggedInFolds = foldByIdentity(
      rows.filter((r) => r.github_hash !== null),
      (r) => r.github_hash,
    );
    const anonymousFolds = foldByIdentity(
      rows.filter((r) => r.github_hash === null),
      (r) => r.identity_hash,
    );

    const totals = rollupSegment(totalFolds, wadDStart);
    const loggedIn = rollupSegment(loggedInFolds, wadDStart);
    const anonymous = rollupSegment(anonymousFolds, wadDStart);

    // Movers: compare current 7d total vs prior 7d total. Reuse rollupSegment
    // by treating the prev window as a one-shot WAD-D window.
    const prevTotalFolds = foldByIdentity(
      prevRows,
      (r) => r.github_hash ?? r.identity_hash,
    );
    const prevTotals = rollupSegment(prevTotalFolds, prevFrom);
    const movers = computeMovers(totals, prevTotals);

    return c.json({
      window: { days, from, to },
      totals,
      segments: {
        logged_in: loggedIn,
        anonymous,
      },
      top_lead_indicators_movers: movers,
      requestId,
    });
  } catch (err) {
    logger.error(
      {
        event: "admin_wad_d_breakdown",
        requestId,
        err: err instanceof Error ? err.message : String(err),
        failed: true,
      },
      "admin-wad-d-breakdown: read failed",
    );
    return c.json({ error: "Read failed", requestId }, 500);
  }
});

export default adminWadDBreakdown;
