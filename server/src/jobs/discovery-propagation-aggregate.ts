/**
 * discovery-propagation-aggregate.ts — Cross-session discovery propagation rollup.
 *
 * Reads session_events rows with non-empty discovery_refs_json arrays and
 * folds each referenced discovery_id into discovery_propagation_stats:
 *
 *   first_seen_at           = MIN(session_events.ended_at) over rows touching it
 *   last_seen_at            = MAX(session_events.ended_at) over rows touching it
 *   session_count           = COUNT(DISTINCT session_id_hash)
 *   distinct_identity_count = COUNT(DISTINCT identity_hash)
 *
 * Invoked from daily-wad-d-aggregate.ts after the WAD-D snapshot upsert.
 * A failure here is best-effort and MUST NOT fail the daily WAD-D rollup.
 *
 * Privacy:
 *   - Never persists identity_hash or session_id_hash. Only COUNT(DISTINCT ...).
 *   - Never logs raw identifiers. Only discovery_id (opaque plugin slug) and
 *     aggregate counts.
 *
 * Hard 5-second wallclock budget — aborts early if it overruns, keeping any
 * partial progress already committed within the per-discovery upsert.
 */

import { Database } from "bun:sqlite";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lookback window when `since` is unspecified. */
const DEFAULT_LOOKBACK_DAYS = 30;

/** Hard wallclock budget — guarded inside the scan loop. */
const BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Lower bound on session_events.ended_at. Defaults to now - 30 days. */
  since?: Date;
  /** Optional injected DB (test path). Defaults to getDb(). */
  db?: Database;
}

export interface RunResult {
  /** Number of distinct discovery_id values upserted. */
  discoveriesProcessed: number;
  /** Number of rows skipped due to JSON parse failure or non-array payload. */
  errors: number;
}

interface SessionEventRow {
  session_id_hash: string;
  identity_hash: string;
  ended_at: string; // ISO timestamp
  discovery_refs_json: string;
}

interface PerDiscoveryAccumulator {
  firstSeenAt: string;
  lastSeenAt: string;
  sessions: Set<string>;
  identities: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoIsLess(a: string, b: string): boolean {
  // ISO 8601 sorts lexicographically when all values are in UTC ("...Z").
  return a < b;
}

/**
 * Safely parse a JSON array of discovery_id strings. Returns null on:
 *   - Invalid JSON
 *   - Not an array
 *   - Empty array (caller treats as no-op, NOT an error)
 *
 * Non-string elements within the array are silently filtered.
 */
function parseDiscoveryRefs(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const filtered = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  return filtered;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Aggregate cross-session discovery propagation counts from session_events.
 *
 * Idempotent: each (re)run UPSERTs by discovery_id, so re-running for the
 * same window produces stable counts.
 */
export async function runDiscoveryPropagationAggregate(
  opts: RunOptions = {},
): Promise<RunResult> {
  const startedMs = Date.now();
  const db = opts.db ?? getDb();
  const since =
    opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  const sinceIso = since.toISOString();

  // Scan candidate rows. The filter `length(discovery_refs_json) > 2` skips
  // the trivial "[]" payload without parsing JSON for every row.
  const rows = db
    .query<SessionEventRow, [string]>(
      `SELECT session_id_hash, identity_hash, ended_at, discovery_refs_json
       FROM session_events
       WHERE discovery_refs_json IS NOT NULL
         AND length(discovery_refs_json) > 2
         AND ended_at >= ?`,
    )
    .all(sinceIso);

  let errors = 0;
  const acc = new Map<string, PerDiscoveryAccumulator>();

  for (const row of rows) {
    // Hard wallclock cutoff. Whatever we've folded so far is still safe to
    // upsert — partial progress is better than zero progress.
    if (Date.now() - startedMs > BUDGET_MS) {
      logger.warn(
        { event: "discovery_propagation_budget", processedSoFar: acc.size },
        "discovery-propagation-aggregate: wallclock budget exceeded — proceeding to upsert partial result",
      );
      break;
    }

    const refs = parseDiscoveryRefs(row.discovery_refs_json);
    if (refs === null) {
      errors += 1;
      continue;
    }

    for (const discoveryId of refs) {
      let entry = acc.get(discoveryId);
      if (!entry) {
        entry = {
          firstSeenAt: row.ended_at,
          lastSeenAt: row.ended_at,
          sessions: new Set<string>(),
          identities: new Set<string>(),
        };
        acc.set(discoveryId, entry);
      } else {
        if (isoIsLess(row.ended_at, entry.firstSeenAt)) entry.firstSeenAt = row.ended_at;
        if (isoIsLess(entry.lastSeenAt, row.ended_at)) entry.lastSeenAt = row.ended_at;
      }
      entry.sessions.add(row.session_id_hash);
      entry.identities.add(row.identity_hash);
    }
  }

  // Upsert everything inside a single transaction. SQLite's UPSERT clause
  // gives us idempotent semantics on re-run; the row's last_aggregated_at
  // gets bumped to `now` so we can observe staleness.
  if (acc.size > 0) {
    const upsert = db.prepare(
      `INSERT INTO discovery_propagation_stats
         (discovery_id, first_seen_at, last_seen_at,
          session_count, distinct_identity_count, last_aggregated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(discovery_id) DO UPDATE SET
         first_seen_at           = MIN(excluded.first_seen_at, discovery_propagation_stats.first_seen_at),
         last_seen_at            = MAX(excluded.last_seen_at, discovery_propagation_stats.last_seen_at),
         session_count           = excluded.session_count,
         distinct_identity_count = excluded.distinct_identity_count,
         last_aggregated_at      = excluded.last_aggregated_at`,
    );
    const tx = db.transaction(() => {
      for (const [discoveryId, entry] of acc) {
        upsert.run(
          discoveryId,
          entry.firstSeenAt,
          entry.lastSeenAt,
          entry.sessions.size,
          entry.identities.size,
        );
      }
    });
    tx();
  }

  return {
    discoveriesProcessed: acc.size,
    errors,
  };
}
