/**
 * _text-helpers — pure string utilities shared across servers.
 *
 * Kept dependency-free so other `_*`-prefixed modules (especially the
 * router-bound `_ask-router.ts`) can import them without pulling a whole
 * tool-server module.
 */

// Minimal English stopword list — enough to filter "how does auth work" → ["auth"].
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the","and","for","are","but","not","you","all","can","her","was","one",
  "our","out","his","who","its","how","what","where","when","why","does",
  "did","done","this","that","those","these","here","there","with","from",
  "into","onto","your","yours","have","has","had","been","being","work",
  "works","working","about","show","tell","explain","please","over","some",
  "such","than","then","them","they","thing","things","stuff","use","used",
  "using","code","file","files","find","look","see","want","need","get",
]);

/**
 * Tokenize a natural-language query into content keywords.
 *
 * - Lowercases, splits on non-alnum/underscore boundaries.
 * - Drops tokens ≤3 chars (avoids pronouns + tool noise).
 * - Drops {@link STOPWORDS}.
 * - Deduplicates, preserving first-occurrence order.
 * - Returns an empty array when no content keywords remain, including for empty input.
 */
export function extractKeywords(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}

/**
 * Truncate `text` to a prefix of at most `maxUnits` UTF-16 code units,
 * never splitting a surrogate pair.
 *
 * Documented limit: the result always satisfies `result.length <= maxUnits`
 * (UTF-16 code units — not bytes, not graphemes) and is a prefix of `text`.
 * When `text` already fits within the limit it is returned unchanged.
 * Otherwise a cut that would land between the two halves of a surrogate
 * pair — an astral character such as emoji or CJK Ext-B in UTF-8-decoded
 * file content — backs off one unit, so the non-BMP character is kept
 * whole or dropped whole and the result never contains an unpaired
 * surrogate. A non-positive or NaN `maxUnits` returns `""`.
 *
 * Use this instead of a bare `text.slice(0, cap)` when user or file
 * content crosses a character cap (orient-server's per-file cap does). It
 * is the single-cap prefix counterpart of the head/tail-safe elision in
 * `_llm-providers` (`snipFallback`).
 */
export function truncateToUnits(text: string, maxUnits: number): string {
  if (Number.isNaN(maxUnits) || maxUnits <= 0) return "";
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  // The cut splits a surrogate pair exactly when the kept prefix ends on a
  // high surrogate whose low half sits one unit past the cut.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) return cut.slice(0, -1);
  return cut;
}
