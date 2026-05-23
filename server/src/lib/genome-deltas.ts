/**
 * lib/genome-deltas.ts — record + read Q2 cloud delta sync entries.
 *
 * One row per GitHub-event-derived genome delta (commit / pr_merged /
 * issue_closed). The webhook handler calls `recordGenomeDelta()` from inside
 * its event switch; the plugin polls via GET /genome/cloud-deltas.
 *
 * Privacy: payload is SUMMARY ONLY — title, message, file paths, optional
 * 2-3 sentence summary. Full diffs MUST NOT be stored here.
 */

import { getDb } from "../db.js";

export type DeltaKind = "commit" | "pr_merged" | "issue_closed";

/** Payload stored as JSON in delta_payload_json. */
export interface CommitDeltaPayload {
  kind: "commit";
  sha: string;
  message: string;        // commit message (full text — small)
  author?: string;
  date?: string;          // ISO
  filesChanged: string[]; // paths only — never content
  summary?: string;       // optional 2-3 sentence high-level summary
}

export interface PrMergedDeltaPayload {
  kind: "pr_merged";
  number: number;
  title: string;
  mergedSha?: string;
  author?: string;
  mergedAt?: string;
  filesChanged: string[];
  summary?: string;
}

export interface IssueClosedDeltaPayload {
  kind: "issue_closed";
  number: number;
  title: string;
  closedAt?: string;
  author?: string;
  summary?: string;
}

export type DeltaPayload =
  | CommitDeltaPayload
  | PrMergedDeltaPayload
  | IssueClosedDeltaPayload;

/** Row shape returned by the GET endpoint and stored in genome_deltas. */
export interface GenomeDeltaRow {
  id: number;
  genome_id: string;
  delta_kind: DeltaKind;
  delta_payload_json: string;
  source_sha: string;
  recorded_at: string;
  consumed_cursor: number;
}

/**
 * Insert one genome delta. Idempotent on (genome_id, delta_kind, source_sha)
 * — the UNIQUE index in schema.ts makes this a no-op for duplicates.
 *
 * Returns { id, cursor, inserted }. When inserted=false the existing row
 * was preserved (cursor will be 0 because we didn't read it back).
 */
export function recordGenomeDelta(params: {
  genomeId: string;
  kind: DeltaKind;
  sourceSha: string;
  payload: DeltaPayload;
}): { id: number; cursor: number; inserted: boolean } {
  const db = getDb();
  const json = JSON.stringify(params.payload);

  // INSERT OR IGNORE → dedup. SQLite returns changes() === 0 when ignored.
  const insertRes = db.run(
    `INSERT OR IGNORE INTO genome_deltas
       (genome_id, delta_kind, delta_payload_json, source_sha, consumed_cursor)
     VALUES (?, ?, ?, ?, 0)`,
    [params.genomeId, params.kind, json, params.sourceSha],
  );
  const inserted = insertRes.changes > 0;

  if (!inserted) {
    return { id: 0, cursor: 0, inserted: false };
  }

  // Mirror id → consumed_cursor. The plugin cursor is monotonic per genome
  // because rowids are monotonic per-table; the WHERE on genome_id during
  // reads keeps each plugin's view in sync.
  const id = Number(insertRes.lastInsertRowid);
  db.run(`UPDATE genome_deltas SET consumed_cursor = ? WHERE id = ?`, [id, id]);
  return { id, cursor: id, inserted: true };
}

/**
 * List deltas for one genome with cursor + limit. Returns rows ordered by
 * consumed_cursor ASC. Caller passes `since_cursor`; we return rows with
 * cursor > since_cursor. The hard cap of 500 matches the spec.
 */
export function listGenomeDeltas(params: {
  genomeId: string;
  sinceCursor: number;
  limit: number;
}): { rows: GenomeDeltaRow[]; nextCursor: number } {
  const limit = Math.max(1, Math.min(500, params.limit | 0));
  const rows = getDb()
    .query<GenomeDeltaRow, [string, number, number]>(
      `SELECT id, genome_id, delta_kind, delta_payload_json, source_sha,
              recorded_at, consumed_cursor
         FROM genome_deltas
        WHERE genome_id = ? AND consumed_cursor > ?
        ORDER BY consumed_cursor ASC
        LIMIT ?`,
    )
    .all(params.genomeId, params.sinceCursor, limit);

  const nextCursor =
    rows.length > 0 ? rows[rows.length - 1]!.consumed_cursor : params.sinceCursor;
  return { rows, nextCursor };
}

/** Test-only: drop everything for a genome. */
export function _deleteGenomeDeltasForGenome(genomeId: string): void {
  getDb().run(`DELETE FROM genome_deltas WHERE genome_id = ?`, [genomeId]);
}
