/**
 * lib/experiments.ts — Server-side A/B experiment assignment + event recording.
 *
 * Assignment is deterministic: SHA-256(key + subjectHash) → bucket number.
 * The same subject always lands in the same variant as long as the experiment's
 * variants array and traffic_pct don't change (treat those as immutable after
 * launch). Assignment rows are persisted so analysis queries are fast.
 *
 * Privacy: subject_hash must already be a one-way fold of the real id.
 * This module never stores or logs raw user/session identifiers.
 */

import { getDb } from "../db/connection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Experiment {
  key: string;
  /** Parsed variant names — e.g. ["a", "b"] */
  variants: string[];
  traffic_pct: number;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic 0–99 bucket from SHA-256(key + subjectHash). */
async function deterministicBucket(key: string, subjectHash: string): Promise<number> {
  const data = new TextEncoder().encode(`${key}:${subjectHash}`);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  // Take the first 4 bytes as a uint32 and mod 100 for a 0–99 bucket.
  const view = new DataView(hashBuf);
  return view.getUint32(0, false) % 100;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up an experiment row and return it (variants parsed), or null.
 */
export async function getExperiment(key: string): Promise<Experiment | null> {
  const db = getDb();
  const row = db.query<{
    key: string;
    variants: string;
    traffic_pct: number;
    started_at: string;
    ended_at: string | null;
    notes: string | null;
  }, [string]>(
    `SELECT key, variants, traffic_pct, started_at, ended_at, notes
       FROM experiments WHERE key = ?`,
  ).get(key);
  if (!row) return null;
  return { ...row, variants: JSON.parse(row.variants) as string[] };
}

/**
 * List experiments that have not ended.
 */
export async function listActiveExperiments(): Promise<Experiment[]> {
  const db = getDb();
  const rows = db.query<{
    key: string;
    variants: string;
    traffic_pct: number;
    started_at: string;
    ended_at: string | null;
    notes: string | null;
  }, []>(
    `SELECT key, variants, traffic_pct, started_at, ended_at, notes
       FROM experiments WHERE ended_at IS NULL ORDER BY started_at DESC`,
  ).all();
  return rows.map((r) => ({ ...r, variants: JSON.parse(r.variants) as string[] }));
}

/**
 * Assign a variant for the given (key, subjectHash) pair.
 *
 * Returns:
 *   - A variant string ("a", "b", …) when the subject is in-traffic.
 *   - null when the experiment doesn't exist, has ended, or the subject
 *     falls outside traffic_pct.
 *
 * Assignment is persisted on first call; subsequent calls return the cached row.
 */
export async function assignVariant(
  key: string,
  subjectHash: string,
): Promise<string | null> {
  const db = getDb();

  // Return existing assignment immediately (idempotent).
  const existing = db.query<{ variant: string }, [string, string]>(
    `SELECT variant FROM experiment_assignments WHERE experiment_key = ? AND subject_hash = ?`,
  ).get(key, subjectHash);
  if (existing) return existing.variant;

  // Load experiment.
  const exp = await getExperiment(key);
  if (!exp || exp.ended_at !== null || exp.variants.length === 0) return null;

  // Bucket the subject.
  const bucket = await deterministicBucket(key, subjectHash);

  // Traffic gate: buckets 0..(traffic_pct-1) are in; the rest are excluded.
  if (bucket >= exp.traffic_pct) return null;

  // Pick variant by mapping the in-traffic bucket to a variant index.
  const variantIndex = bucket % exp.variants.length;
  const variant = exp.variants[variantIndex]!;

  // Persist assignment (ignore conflict — another process may have inserted).
  try {
    db.run(
      `INSERT OR IGNORE INTO experiment_assignments (experiment_key, subject_hash, variant)
       VALUES (?, ?, ?)`,
      [key, subjectHash, variant],
    );
  } catch {
    // Race — read back what was actually stored.
    const raced = db.query<{ variant: string }, [string, string]>(
      `SELECT variant FROM experiment_assignments WHERE experiment_key = ? AND subject_hash = ?`,
    ).get(key, subjectHash);
    if (raced) return raced.variant;
  }

  return variant;
}

/**
 * Record an experiment event (exposure, conversion, or any custom string).
 * Best-effort: never throws.
 */
export function recordExperimentEvent(
  key: string,
  variant: string,
  subjectHash: string,
  event: string,
  payload?: Record<string, unknown>,
): void {
  try {
    const db = getDb();
    db.run(
      `INSERT INTO experiment_events (experiment_key, variant, subject_hash, event, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
      [key, variant, subjectHash, event, payload ? JSON.stringify(payload) : null],
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Stamp ended_at on an experiment to stop new assignments.
 * Existing assignments are preserved for post-hoc analysis.
 */
export function endExperiment(key: string, notes?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (notes !== undefined) {
    db.run(
      `UPDATE experiments SET ended_at = ?, notes = ? WHERE key = ?`,
      [now, notes, key],
    );
  } else {
    db.run(`UPDATE experiments SET ended_at = ? WHERE key = ?`, [now, key]);
  }
}
