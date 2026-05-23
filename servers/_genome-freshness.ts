/**
 * _genome-freshness.ts — render compact freshness badges for retrieved
 * genome sections (Q2 prep, foundational work).
 *
 * The v2 manifest (`_manifest-v2.ts`) carries `lastUpdatedAt` on every
 * section. Surfacing that age in grep output lets the human + the model
 * see at a glance whether the retrieved context is current.
 *
 * Badge format (max ~15 chars):
 *   <1h   → `[fresh]`
 *   <24h  → `[fresh: Xh]`
 *   <7d   → `[fresh: Xd]`
 *   <30d  → `[stale: Xd]`
 *   ≥30d  → `[stale: ≥30d]`
 *   undef → `""`  (legacy v1 sections; render nothing — caller stays safe)
 *
 * Decoration is purely additive: legacy v1 sections still render unchanged
 * because their entry in the freshness map is absent.
 */

import { loadManifestV2 } from "./_manifest-v2";

// ---------------------------------------------------------------------------
// Pure helper — no I/O, fully tested.
// ---------------------------------------------------------------------------

/**
 * Format a freshness badge from an ISO timestamp.
 *
 * Returns "" when `lastUpdatedAt` is undefined OR fails to parse — callers
 * can safely splice the result into any string template without guarding.
 *
 * Bucket boundaries are inclusive on the LOWER bound and exclusive on the
 * UPPER bound. e.g. exactly 1h old → `[fresh: 1h]` (>= 1h, < 24h).
 */
export function formatFreshness(
  lastUpdatedAt: string | undefined,
  now: Date = new Date(),
): string {
  if (!lastUpdatedAt) return "";
  const t = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(t)) return "";

  const ageMs = now.getTime() - t;
  if (ageMs < 0) {
    // Future timestamp — treat as fresh-just-now rather than emitting
    // misleading "stale" text or empty string.
    return "[fresh]";
  }

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  if (ageMs < HOUR) return "[fresh]";
  if (ageMs < DAY) {
    const hours = Math.floor(ageMs / HOUR);
    return `[fresh: ${hours}h]`;
  }
  if (ageMs < 7 * DAY) {
    const days = Math.floor(ageMs / DAY);
    return `[fresh: ${days}d]`;
  }
  if (ageMs < 30 * DAY) {
    const days = Math.floor(ageMs / DAY);
    return `[stale: ${days}d]`;
  }
  return "[stale: >=30d]";
}

// ---------------------------------------------------------------------------
// Manifest lookup
// ---------------------------------------------------------------------------

/**
 * Build a (sectionPath → lastUpdatedAt) lookup from the v2 manifest at `cwd`.
 *
 * Returns an empty Map when:
 *   - no genome exists,
 *   - the manifest is unreadable,
 *   - sections have no lastUpdatedAt (legacy v1 not yet re-saved).
 *
 * Never throws. Safe to call on every grep retrieval.
 */
export async function loadSectionFreshnessMap(
  cwd: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const manifest = await loadManifestV2(cwd);
    if (!manifest) return out;
    for (const s of manifest.sections) {
      if (s.lastUpdatedAt) out.set(s.path, s.lastUpdatedAt);
    }
  } catch {
    // Best-effort — never break retrieval.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output decoration
// ---------------------------------------------------------------------------

/**
 * Inject freshness badges into core-efficiency's formatGenomeForPrompt
 * output. Targets each `### <title> (<path>)` header — if the path is in
 * `freshnessMap` we append ` <badge>`. Headers with no metadata are left
 * untouched (legacy v1 safety net).
 *
 * Pure / synchronous. Idempotent — re-running on already-decorated output
 * is a no-op because the regex matches only un-decorated headers.
 */
export function decorateGenomeOutputWithFreshness(
  formatted: string,
  freshnessMap: Map<string, string>,
  now: Date = new Date(),
): string {
  if (formatted.length === 0 || freshnessMap.size === 0) return formatted;

  // Match: `### <title> (<path>)` at start of a line. Path is greedy-by-
  // necessity (titles can contain parens), so we anchor to the LAST `(...)`
  // on the line by requiring the trailing `)` to be followed by end-of-line
  // or whitespace — works for the core-efficiency formatter's exact output.
  return formatted.replace(
    /^### (.+?) \(([^()\n]+)\)(?= *$)/gm,
    (whole, title: string, path: string) => {
      const ts = freshnessMap.get(path);
      if (!ts) return whole;
      const badge = formatFreshness(ts, now);
      if (!badge) return whole;
      return `### ${title} (${path}) ${badge}`;
    },
  );
}
