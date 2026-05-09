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
