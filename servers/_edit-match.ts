/**
 * _edit-match.ts — Shared helpers for fuzzy search/replace matching.
 *
 * Exports:
 *   levenshtein    — used by both fuzzyTopLines (hint display) and findFuzzyMatch
 *   fuzzyTopLines  — top-3 closest lines for error hints (unchanged behavior)
 *   findFuzzyMatch — two-tier fuzzy matcher, returns start/end byte offsets
 *
 * Design principles:
 *   - Conservative: only returns a match when confidence is HIGH and UNIQUE.
 *   - Never returns a low-confidence or ambiguous match.
 *   - Caps work on huge files (>2 MB) → returns null fast.
 *   - All errors swallowed by callers; this module must never throw.
 */

/** Levenshtein distance (capped at maxDist for speed). */
export function levenshtein(a: string, b: string, maxDist = 256): number {
  if (a === b) return 0;
  if (a.length === 0) return Math.min(b.length, maxDist);
  if (b.length === 0) return Math.min(a.length, maxDist);
  const A = a.slice(0, 200);
  const B = b.slice(0, 200);
  const m = A.length, n = B.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Return top-3 closest lines to `search` from `content`, with similarity scores. */
export function fuzzyTopLines(
  search: string,
  content: string,
): Array<{ lineNo: number; text: string; sim: number }> {
  const needle = search.split("\n")[0].trim().slice(0, 200);
  const lines = content.split("\n");
  const results: Array<{ lineNo: number; text: string; sim: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const dist = levenshtein(needle, line.slice(0, 200));
    const maxLen = Math.max(needle.length, line.length, 1);
    const sim = Math.round((1 - dist / maxLen) * 100) / 100;
    results.push({ lineNo: i + 1, text: lines[i], sim });
  }
  results.sort((a, b) => b.sim - a.sim);
  return results.slice(0, 3);
}

/** Result from a successful fuzzy match. */
export interface FuzzyMatchResult {
  /** Byte offset of match start in `content`. */
  start: number;
  /** Byte offset of match end (exclusive) in `content`. */
  end: number;
  /** Similarity score [0..1]. */
  score: number;
}

const FUZZY_CONTENT_LIMIT = 2 * 1024 * 1024; // 2 MB

/**
 * Try to find a fuzzy match for `search` in `content`.
 *
 * Tier 1 — whitespace-normalized unique match:
 *   Normalize each run of whitespace to a single space and trim; if exactly ONE
 *   normalized occurrence maps to a real offset → return it (score 1.0).
 *
 * Tier 2 — block Levenshtein:
 *   Slide a window of search's line count over content's lines; compute
 *   per-window normalized similarity; accept ONLY IF best >= 0.90 AND the
 *   margin over the 2nd-best is >= 0.05 (uniqueness guard).
 *
 * Returns null when no confident, unambiguous match is found.
 * NEVER called for content > 2 MB (caller guards).
 */
export function findFuzzyMatch(
  content: string,
  search: string,
): FuzzyMatchResult | null {
  if (!search || !content) return null;
  if (content.length > FUZZY_CONTENT_LIMIT) return null;

  // -------------------------------------------------------------------------
  // Tier 1: whitespace-normalized match
  // -------------------------------------------------------------------------
  const normalizeWS = (s: string) =>
    s.replace(/[ \t]+/g, " ").replace(/^ /gm, "").replace(/ $/gm, "").trimEnd();

  const normContent = normalizeWS(content);
  const normSearch = normalizeWS(search);

  if (normSearch.length > 0) {
    // Find all occurrences in normalized content.
    const occurrences: number[] = [];
    let pos = 0;
    while ((pos = normContent.indexOf(normSearch, pos)) !== -1) {
      occurrences.push(pos);
      pos += normSearch.length;
    }

    if (occurrences.length === 1) {
      // Map normalized offset back to original content offset.
      // We rebuild the mapping by walking both strings in tandem.
      const normToOrig = buildNormToOrigMap(content, normContent);
      const normStart = occurrences[0];
      const normEnd = normStart + normSearch.length;

      const origStart = normToOrig[normStart];
      if (origStart === undefined) {
        // Could not map back to original offset — skip Tier 1.
      } else {
        // For end, we use normEnd-1 to get the last char's orig position, then
        // advance past it. Guard against out-of-bounds.
        const origEnd =
          normEnd > 0 && normToOrig[normEnd - 1] !== undefined
            ? normToOrig[normEnd - 1]! + 1
            : origStart + search.length;

        if (origEnd > origStart) {
          return { start: origStart, end: origEnd, score: 1.0 };
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tier 2: block Levenshtein over line windows
  // -------------------------------------------------------------------------
  const searchLines = search.split("\n");
  const contentLines = content.split("\n");
  const windowSize = searchLines.length;

  if (windowSize === 0 || contentLines.length < windowSize) return null;

  // Build a flat string per window for distance comparison.
  const searchFlat = searchLines.map(l => l.trim()).join("\n");

  interface WindowScore { lineIdx: number; score: number }
  let best: WindowScore | null = null;
  let secondBest: WindowScore | null = null;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const windowFlat = contentLines.slice(i, i + windowSize).map(l => l.trim()).join("\n");
    const dist = levenshtein(searchFlat, windowFlat, 512);
    const maxLen = Math.max(searchFlat.length, windowFlat.length, 1);
    const score = 1 - dist / maxLen;

    if (!best || score > best.score) {
      secondBest = best;
      best = { lineIdx: i, score };
    } else if (!secondBest || score > secondBest.score) {
      secondBest = { lineIdx: i, score };
    }
  }

  if (!best) return null;

  // Confidence gate: score >= 0.90 AND margin over 2nd-best >= 0.05.
  const margin = secondBest ? best.score - secondBest.score : 1;
  if (best.score < 0.90 || margin < 0.05) return null;

  // Map best window back to byte offsets.
  const start = lineToOffset(content, best.lineIdx);
  const endLineIdx = best.lineIdx + windowSize;
  const end =
    endLineIdx >= contentLines.length
      ? content.length
      : lineToOffset(content, endLineIdx);

  return { start, end, score: Math.round(best.score * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a map: normContent index → original content index.
 * Both strings must have been produced by the same normalizeWS logic above.
 */
function buildNormToOrigMap(orig: string, norm: string): Array<number | undefined> {
  const map: Array<number | undefined> = new Array(norm.length + 1).fill(undefined);
  let oi = 0; // index into orig
  let ni = 0; // index into norm

  while (ni < norm.length && oi < orig.length) {
    // Skip whitespace runs in orig that were collapsed to a single space in norm.
    // The normalizer collapses /[ \t]+/ → " " and trims line ends, but newlines
    // are preserved. We handle char-by-char.
    const nc = norm[ni];
    const oc = orig[oi];

    if (nc === oc) {
      map[ni] = oi;
      ni++;
      oi++;
    } else if (nc === " " && (oc === " " || oc === "\t")) {
      // Collapsed whitespace: norm has one space, orig has one or more spaces/tabs.
      map[ni] = oi;
      ni++;
      oi++;
      // Skip remaining contiguous spaces/tabs in orig.
      while (oi < orig.length && (orig[oi] === " " || orig[oi] === "\t")) {
        oi++;
      }
    } else {
      // Mismatch not explained by WS collapse — advance orig to resync.
      // This handles trimmed leading/trailing spaces on lines.
      oi++;
    }
  }
  return map;
}

/**
 * Return the byte offset of the start of line `lineIdx` (0-based) in `content`.
 */
function lineToOffset(content: string, lineIdx: number): number {
  if (lineIdx === 0) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      count++;
      if (count === lineIdx) return i + 1;
    }
  }
  return content.length;
}
