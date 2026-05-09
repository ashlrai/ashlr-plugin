/**
 * db/genome-insights.ts — Pro-tier "Genome Insights" query.
 *
 * Surfaces what the team's genome actually learned this week:
 *   - which sections were pushed most (retrieval proxy)
 *   - how many sections were added / modified
 *   - total push events (retrieval proxy) and a cache-hit-rate proxy
 *
 * There is no dedicated retrieval-tracking table today, so push frequency
 * from genome_push_log is used as the retrieval proxy — sections that are
 * pushed often are sections that are actively used.
 *
 * Cache-hit-rate is derived from telemetry_events where
 *   kind = 'genome_compression_ratio'
 * If no such events exist the value defaults to 0.
 *
 * Authorization: caller must have already resolved userId → orgId → genome.
 * This function ONLY accepts a resolved genomeId so it carries no auth logic.
 */

import { getDb } from "./connection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenomeInsightSection {
  name: string;       // the path value from genome_push_log / genome_sections
  retrievals: number; // push count within the window (retrieval proxy)
  bytes: number;      // current content length in genome_sections (0 if not found)
}

export interface GenomeInsights {
  top_sections: GenomeInsightSection[];
  sections_added_this_week: number;
  sections_modified_this_week: number;
  total_retrievals_week: number;
  cache_hit_rate: number; // 0–1 fraction
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Return GenomeInsights for a single genome over the last `windowDays` days.
 * The caller (route layer) is responsible for resolving userId → genomeId
 * and confirming ownership before calling this function.
 */
export function getGenomeInsights(
  genomeId: string,
  windowDays: number,
): GenomeInsights {
  const db = getDb();
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // -- Top sections by push frequency (retrieval proxy) ---------------------
  const topSectionsRaw = db
    .query<{ name: string; retrievals: number }, [string, string, number]>(
      `SELECT
         path                     AS name,
         COUNT(*)                 AS retrievals
       FROM genome_push_log
       WHERE genome_id = ?
         AND at >= ?
       GROUP BY path
       ORDER BY retrievals DESC
       LIMIT ?`,
    )
    .all(genomeId, since, 10);

  // Enrich with current byte size from genome_sections
  const top_sections: GenomeInsightSection[] = topSectionsRaw.map((row) => {
    const section = db
      .query<{ bytes: number }, [string, string]>(
        `SELECT length(content) AS bytes
           FROM genome_sections
          WHERE genome_id = ? AND path = ?`,
      )
      .get(genomeId, row.name);
    return { name: row.name, retrievals: row.retrievals, bytes: section?.bytes ?? 0 };
  });

  // -- Total push events in window (retrieval total proxy) ------------------
  const totalRow = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n
         FROM genome_push_log
        WHERE genome_id = ? AND at >= ?`,
    )
    .get(genomeId, since);
  const total_retrievals_week = totalRow?.n ?? 0;

  // -- Sections added vs modified this week ---------------------------------
  // "added" = first push for that path falls within the window
  // "modified" = path existed before the window but has a push within it
  const activityRows = db
    .query<{ path: string; first_push: string; window_pushes: number }, [string, string]>(
      `SELECT
         path,
         MIN(at) AS first_push,
         COUNT(*) FILTER (WHERE at >= ?) AS window_pushes
       FROM genome_push_log
       WHERE genome_id = ?
       GROUP BY path`,
    )
    .all(since, genomeId);

  let sections_added_this_week = 0;
  let sections_modified_this_week = 0;
  for (const r of activityRows) {
    if (r.window_pushes === 0) continue;
    if (r.first_push >= since) {
      sections_added_this_week += 1;
    } else {
      sections_modified_this_week += 1;
    }
  }

  // -- Cache-hit-rate from telemetry_events ---------------------------------
  // kind = 'genome_compression_ratio' payload stores the ratio as the numeric
  // value field. We average recent events as a proxy for cache effectiveness.
  // Falls back to 0 when no telemetry is present.
  const cacheRow = db
    .query<{ avg_ratio: number | null }, [string]>(
      `SELECT AVG(CAST(payload AS REAL)) AS avg_ratio
         FROM telemetry_events
        WHERE kind = 'genome_compression_ratio'
          AND stored_at >= ?`,
    )
    .get(since);
  const cache_hit_rate = Math.min(1, Math.max(0, cacheRow?.avg_ratio ?? 0));

  return {
    top_sections,
    sections_added_this_week,
    sections_modified_this_week,
    total_retrievals_week,
    cache_hit_rate,
  };
}

/**
 * Resolve the genome that belongs to the given user (via org_id or personal
 * owner_user_id). Returns null when the user has no genome — callers should
 * return an empty GenomeInsights rather than 404 so the dashboard can render
 * the empty state without special-casing HTTP errors.
 */
export function getGenomeIdForUser(userId: string): string | null {
  const db = getDb();
  // Personal genome (owner_user_id)
  const personal = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM genomes WHERE owner_user_id = ? LIMIT 1`,
    )
    .get(userId);
  if (personal) return personal.id;

  // Team genome (org_id)
  const team = db
    .query<{ id: string }, [string]>(
      `SELECT g.id
         FROM genomes g
         JOIN users u ON u.org_id = g.org_id
        WHERE u.id = ?
        LIMIT 1`,
    )
    .get(userId);
  return team?.id ?? null;
}

// ---------------------------------------------------------------------------
// Empty-result helper
// ---------------------------------------------------------------------------

export function emptyGenomeInsights(): GenomeInsights {
  return {
    top_sections: [],
    sections_added_this_week: 0,
    sections_modified_this_week: 0,
    total_retrievals_week: 0,
    cache_hit_rate: 0,
  };
}

// ---------------------------------------------------------------------------
// Admin-scope types
// ---------------------------------------------------------------------------

export interface AdminGenomeRow {
  genome_id: string;
  org_id: string;
  member_count: number;
  last_push_at: string | null;
  push_count_30d: number;
  total_bytes: number;
}

export interface AdminGenomeSectionRow {
  path: string;
  retrieval_count: number;
  bytes: number;
}

export interface AdminGenomeContributorRow {
  client_id_redacted: string; // first 8 chars of client_id
  push_count: number;
}

export interface AdminGenomeSyncDay {
  day: string;
  push_count: number;
}

export interface AdminGenomeDetail {
  genome_id: string;
  org_id: string;
  member_count: number;
  sections: AdminGenomeSectionRow[];
  top_contributors: AdminGenomeContributorRow[];
  sync_history: AdminGenomeSyncDay[];
  conflict_count_30d: number;
  retrieval_count_30d: number;
}

export interface AdminGenomeConflictRow {
  genome_id: string;
  conflicting_user_id_redacted: string; // first 8 chars of path or client_id
  ts: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Admin queries — no auth logic; caller (route layer) must have verified admin
// ---------------------------------------------------------------------------

/**
 * List all genomes sorted by activity (30d push count desc).
 */
export function adminListAllGenomes(): AdminGenomeRow[] {
  const db = getDb();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const rows = db
    .query<{
      genome_id: string;
      org_id: string;
      last_push_at: string | null;
      push_count_30d: number;
    }, [string]>(
      `SELECT
         g.id                                        AS genome_id,
         g.org_id,
         MAX(p.at)                                   AS last_push_at,
         COUNT(CASE WHEN p.at >= ? THEN 1 END)       AS push_count_30d
       FROM genomes g
       LEFT JOIN genome_push_log p ON p.genome_id = g.id
       GROUP BY g.id, g.org_id
       ORDER BY push_count_30d DESC, last_push_at DESC`,
    )
    .all(since30);

  return rows.map((r) => {
    // member count: distinct users whose org_id matches, plus key-envelope members
    const memberRow = db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(DISTINCT u.id) AS n
           FROM users u
          WHERE u.org_id = ?
            AND u.id IS NOT NULL
         UNION ALL
         SELECT COUNT(DISTINCT ke.member_user_id)
           FROM genome_key_envelopes ke
          WHERE ke.genome_id = ? AND ke.revoked_at IS NULL`,
      )
      .all(r.org_id, r.genome_id);
    const member_count = memberRow.reduce((acc, m) => acc + m.n, 0);

    // total bytes from genome_sections
    const bytesRow = db
      .query<{ total: number }, [string]>(
        `SELECT COALESCE(SUM(length(content)), 0) AS total
           FROM genome_sections
          WHERE genome_id = ?`,
      )
      .get(r.genome_id);

    return {
      genome_id: r.genome_id,
      org_id: r.org_id,
      member_count,
      last_push_at: r.last_push_at,
      push_count_30d: r.push_count_30d,
      total_bytes: bytesRow?.total ?? 0,
    };
  });
}

/**
 * Return detailed view for a single genome.
 */
export function adminGetGenomeDetail(genomeId: string): AdminGenomeDetail | null {
  const db = getDb();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const genomeRow = db
    .query<{ id: string; org_id: string }, [string]>(
      `SELECT id, org_id FROM genomes WHERE id = ?`,
    )
    .get(genomeId);

  if (!genomeRow) return null;

  // Member count
  const memberRows = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(DISTINCT u.id) AS n
         FROM users u
        WHERE u.org_id = ?
          AND u.id IS NOT NULL
       UNION ALL
       SELECT COUNT(DISTINCT ke.member_user_id)
         FROM genome_key_envelopes ke
        WHERE ke.genome_id = ? AND ke.revoked_at IS NULL`,
    )
    .all(genomeRow.org_id, genomeId);
  const member_count = memberRows.reduce((acc, m) => acc + m.n, 0);

  // Top sections by push frequency (retrieval proxy) in last 30d
  const topSectionsRaw = db
    .query<{ path: string; retrieval_count: number }, [string, string, number]>(
      `SELECT path, COUNT(*) AS retrieval_count
         FROM genome_push_log
        WHERE genome_id = ? AND at >= ?
        GROUP BY path
        ORDER BY retrieval_count DESC
        LIMIT ?`,
    )
    .all(genomeId, since30, 20);

  const sections: AdminGenomeSectionRow[] = topSectionsRaw.map((s) => {
    const bytesRow = db
      .query<{ bytes: number }, [string, string]>(
        `SELECT length(content) AS bytes FROM genome_sections WHERE genome_id = ? AND path = ?`,
      )
      .get(genomeId, s.path);
    return { path: s.path, retrieval_count: s.retrieval_count, bytes: bytesRow?.bytes ?? 0 };
  });

  // Top contributors: client_id from push_log (redacted to first 8 chars)
  const contribRaw = db
    .query<{ client_id: string; push_count: number }, [string, string]>(
      `SELECT client_id, COUNT(*) AS push_count
         FROM genome_push_log
        WHERE genome_id = ? AND at >= ?
        GROUP BY client_id
        ORDER BY push_count DESC
        LIMIT 10`,
    )
    .all(genomeId, since30);

  const top_contributors: AdminGenomeContributorRow[] = contribRaw.map((c) => ({
    client_id_redacted: c.client_id.slice(0, 8),
    push_count: c.push_count,
  }));

  // Sync history: daily push counts for last 30 days
  const syncRaw = db
    .query<{ day: string; push_count: number }, [string, string]>(
      `SELECT strftime('%Y-%m-%d', at) AS day, COUNT(*) AS push_count
         FROM genome_push_log
        WHERE genome_id = ? AND at >= ?
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(genomeId, since30);

  const sync_history: AdminGenomeSyncDay[] = syncRaw;

  // Conflict count 30d
  const conflictRow = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n
         FROM genome_conflicts
        WHERE genome_id = ? AND detected_at >= ?`,
    )
    .get(genomeId, since30);
  const conflict_count_30d = conflictRow?.n ?? 0;

  // Retrieval count 30d (total push events as proxy)
  const retrievalRow = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM genome_push_log WHERE genome_id = ? AND at >= ?`,
    )
    .get(genomeId, since30);
  const retrieval_count_30d = retrievalRow?.n ?? 0;

  return {
    genome_id: genomeId,
    org_id: genomeRow.org_id,
    member_count,
    sections,
    top_contributors,
    sync_history,
    conflict_count_30d,
    retrieval_count_30d,
  };
}

/**
 * Cross-genome conflicts feed for the last windowDays days.
 * Returns conflicts sorted by detected_at desc, with client identifier redacted.
 */
export function adminListGenomeConflicts(windowDays = 30): AdminGenomeConflictRow[] {
  const db = getDb();
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const rows = db
    .query<{ genome_id: string; path: string; detected_at: string; variants_json: string }, [string]>(
      `SELECT genome_id, path, detected_at, variants_json
         FROM genome_conflicts
        WHERE detected_at >= ?
        ORDER BY detected_at DESC
        LIMIT 200`,
    )
    .all(since);

  return rows.map((r) => {
    // Parse variants to extract a brief summary (first variant's first 80 chars)
    let summary = r.path;
    try {
      const variants = JSON.parse(r.variants_json) as string[];
      if (variants.length > 0 && variants[0]) {
        summary = variants[0].slice(0, 80);
      }
    } catch { /* ignore parse errors */ }

    return {
      genome_id: r.genome_id,
      // Use path as the "conflicting user" proxy — redact to first 8 chars of the path hash
      conflicting_user_id_redacted: r.path.slice(0, 8),
      ts: r.detected_at,
      summary,
    };
  });
}
