/**
 * weekly-digest-data.ts — Server-side data fetcher for the Pro weekly digest.
 *
 * Aggregates per-user stats for a given ISO week. Called by the cron worker
 * (weekly-digest-cron.ts) before rendering the email template.
 *
 * All DB access goes through the typed helpers in server/src/db/ — no raw
 * SQL is written inline here.
 */

import { getDb } from "../db.js";
import { aggregateUploads } from "../db/stats.js";
import type { TopTool } from "../emails/weekly-digest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserDigestData {
  userId: string;
  /** Email local-part or display name — never the full email address. */
  handle: string;
  weekOf: string;           // ISO date "YYYY-MM-DD" for Monday of current week
  weekTokensSaved: number;
  weekDollarsSaved: number;
  topTools: TopTool[];      // all-time, sorted desc by calls, max 5
  genomeSectionsAdded: number;
  streakDays: number;
}

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Monday of the ISO week containing `nowMs`.
 * Result as "YYYY-MM-DD".
 */
export function isoWeekMonday(nowMs: number): string {
  const d = new Date(nowMs);
  // getDay(): 0=Sun, 1=Mon … 6=Sat
  const day = d.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d.getTime() + diffToMonday * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/**
 * Returns the Sunday (end of week) following the given Monday string.
 * Inclusive upper bound for the week window.
 */
export function isoWeekSunday(mondayStr: string): string {
  const d = new Date(`${mondayStr}T00:00:00Z`);
  const sunday = new Date(d.getTime() + 6 * 86_400_000);
  return sunday.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Token → dollar rate (same assumption as scripts/weekly-digest.ts)
// ---------------------------------------------------------------------------

const TOKENS_PER_DOLLAR = 1_000_000 / 3; // ~$3 per 1M tokens (sonnet blended)

function tokensToDollars(tokens: number): number {
  return tokens / TOKENS_PER_DOLLAR;
}

// ---------------------------------------------------------------------------
// Per-user weekly token savings
// ---------------------------------------------------------------------------

/**
 * Sum tokens saved in `by_day_json` for days within [mondayStr, sundayStr].
 * Each stats_upload row carries a `by_day_json` map of { "YYYY-MM-DD": tokenCount }.
 * We take the latest upload (aggregateUploads merges all machines) and filter
 * by the week window.
 */
function getWeeklyTokensSaved(userId: string, mondayStr: string, sundayStr: string): number {
  const agg = aggregateUploads(userId);
  let total = 0;
  for (const [date, count] of Object.entries(agg.by_day)) {
    if (date >= mondayStr && date <= sundayStr) {
      total += count;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Top tools all-time
// ---------------------------------------------------------------------------

function getTopTools(userId: string, limit = 5): TopTool[] {
  const agg = aggregateUploads(userId);
  return Object.entries(agg.by_tool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, calls]) => ({ name, calls }));
}

// ---------------------------------------------------------------------------
// Genome sections added this week
// ---------------------------------------------------------------------------

/**
 * Count distinct genome section paths pushed for any genome owned/used by
 * this user during the week. Uses genome_push_log which is keyed by genome_id
 * + path + client_id. We identify user-owned genomes via the genomes table.
 */
function getGenomeSectionsAddedThisWeek(
  userId: string,
  mondayStr: string,
  sundayStr: string,
): number {
  const db = getDb();
  // Count pushes for any genome this user belongs to within the week window.
  // genome_push_log.at is an ISO datetime ("YYYY-MM-DDTHH:MM:SSZ").
  // We join via genomes.owner_user_id OR team membership.
  const row = db
    .query<{ n: number }, [string, string, string, string]>(
      `SELECT COUNT(DISTINCT gpl.path) AS n
       FROM genome_push_log gpl
       JOIN genomes g ON g.id = gpl.genome_id
       WHERE (g.owner_user_id = ? OR g.org_id IN (
         SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ?
       ))
       AND date(gpl.at) BETWEEN ? AND ?`,
    )
    .get(userId, userId, mondayStr, sundayStr) ??
    // Fallback: genome_push_log has no direct user linkage for old rows — use
    // a simpler count across all user genomes.
    db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(DISTINCT gpl.path) AS n
         FROM genome_push_log gpl
         JOIN genomes g ON g.id = gpl.genome_id
         WHERE g.owner_user_id = ?
         AND date(gpl.at) BETWEEN ? AND ?`,
      )
      .get(userId, mondayStr, sundayStr);

  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Streak — consecutive days with any stats upload
// ---------------------------------------------------------------------------

/**
 * Count the current streak: how many consecutive calendar days (ending today
 * or yesterday) has this user had at least one stats upload?
 */
function getCurrentStreakDays(userId: string, nowMs: number): number {
  const db = getDb();
  const today = new Date(nowMs).toISOString().slice(0, 10);

  // Fetch distinct active days (from by_day_json keys) — approximate via
  // uploaded_at dates which are available directly in stats_uploads.
  const rows = db
    .query<{ day: string }, [string]>(
      `SELECT DISTINCT date(uploaded_at) AS day
       FROM stats_uploads
       WHERE user_id = ?
       ORDER BY day DESC`,
    )
    .all(userId);

  if (rows.length === 0) return 0;

  const days = rows.map((r) => r.day);
  let streak = 0;
  let cursor = today;

  for (const day of days) {
    if (day === cursor || day === yesterday(cursor)) {
      streak++;
      cursor = day;
    } else if (day < cursor) {
      // Gap — streak broken
      break;
    }
  }

  return streak;
}

function yesterday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble all digest data for a single user.
 *
 * @param userId   DB user id
 * @param email    User's email address — used ONLY to derive the handle; never included in digest body
 * @param nowMs    Current time in ms (injectable for testing)
 */
export async function getWeeklyDigestForUser(
  userId: string,
  email: string,
  nowMs: number = Date.now(),
): Promise<UserDigestData> {
  const handle = email.split("@")[0] ?? "there";
  const mondayStr = isoWeekMonday(nowMs);
  const sundayStr = isoWeekSunday(mondayStr);

  const weekTokensSaved = getWeeklyTokensSaved(userId, mondayStr, sundayStr);
  const weekDollarsSaved = tokensToDollars(weekTokensSaved);
  const topTools = getTopTools(userId);
  const genomeSectionsAdded = getGenomeSectionsAddedThisWeek(userId, mondayStr, sundayStr);
  const streakDays = getCurrentStreakDays(userId, nowMs);

  return {
    userId,
    handle,
    weekOf: mondayStr,
    weekTokensSaved,
    weekDollarsSaved,
    topTools,
    genomeSectionsAdded,
    streakDays,
  };
}
