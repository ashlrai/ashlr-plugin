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
