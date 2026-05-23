/**
 * _genome-discoveries.ts — surface AI-synthesized discovery sections in
 * ashlr__grep retrieval.
 *
 * Mirrors `_genome-commits.ts` but for `kind: "discovery"` sections produced
 * by `scripts/genome-synthesizer.ts`. Reuses the keyword scorer exported by
 * the commit module so we have a single source of truth for tag/title/summary
 * scoring across all v2 section kinds.
 *
 * Discoveries are ADDITIVE — they extend the corpus, never replace it. The
 * grep handler formats them with a distinct `[discovery <id> - <date>]`
 * prefix and a `## Discoveries` header so users can tell synthesis insights
 * from static code and from raw commit history.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import {
  type DiscoverySection,
  type SectionMetaV2,
  discoverySectionAbsPath,
  loadManifestV2,
} from "./_manifest-v2";
import { scoreSectionMeta, tokenize } from "./_genome-commits";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RetrievedDiscovery {
  id: string;
  shortId: string;
  synthesizedAt: string;
  summary: string;
  evidence: DiscoverySection["evidence"];
  sourceCommits: string[];
  confidence: number;
  score: number;
}

/**
 * Retrieve up to `limit` discovery sections matching `query`.
 *
 * Returns an empty array when:
 *   - no genome exists,
 *   - the manifest has no discovery sections,
 *   - no discovery section's keywords overlap the query.
 *
 * Never throws — best-effort retrieval, callers should fall through to
 * static + commit results when this returns [].
 */
export async function retrieveDiscoverySections(
  cwd: string,
  query: string,
  limit = 3,
): Promise<RetrievedDiscovery[]> {
  try {
    const manifest = await loadManifestV2(cwd);
    if (!manifest) return [];

    const discoveryMetas = manifest.sections.filter((s) => s.kind === "discovery");
    if (discoveryMetas.length === 0) return [];

    const queryTerms = new Set(tokenize(query));
    let scored: Array<{ meta: SectionMetaV2; score: number }>;

    if (queryTerms.size === 0) {
      // No meaningful query — surface the most recent discoveries.
      scored = discoveryMetas.map((m) => ({ meta: m, score: 1 }));
    } else {
      scored = discoveryMetas
        .map((m) => ({ meta: m, score: scoreSectionMeta(m, queryTerms) }))
        .filter((s) => s.score > 0);
    }

    if (scored.length === 0) return [];

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ad = a.meta.lastUpdatedAt ?? a.meta.updatedAt;
      const bd = b.meta.lastUpdatedAt ?? b.meta.updatedAt;
      return bd > ad ? 1 : bd < ad ? -1 : 0;
    });

    const out: RetrievedDiscovery[] = [];
    for (const { meta, score } of scored.slice(0, limit)) {
      const id = meta.path.replace(/^discoveries\//, "").replace(/\.json$/, "");
      const abs = discoverySectionAbsPath(cwd, id);
      if (!existsSync(abs)) continue;
      let payload: DiscoverySection;
      try {
        payload = JSON.parse(await readFile(abs, "utf-8")) as DiscoverySection;
      } catch {
        continue;
      }
      out.push({
        id: payload.id,
        shortId: payload.id.slice(0, 7),
        synthesizedAt: payload.synthesizedAt,
        summary: payload.summary,
        evidence: payload.evidence,
        sourceCommits: payload.sourceCommits,
        confidence: payload.confidence,
        score,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Format a list of retrieved discovery sections as a markdown block suitable
 * for prepending to grep output. Each discovery is clearly labeled with
 * `[discovery <id> - <date>]` so users see it's AI-synthesized, not static
 * documentation or raw commit history.
 */
export function formatDiscoveriesForPrompt(discoveries: RetrievedDiscovery[]): string {
  if (discoveries.length === 0) return "";
  const parts = discoveries.map((d) => {
    const dateShort = d.synthesizedAt ? d.synthesizedAt.slice(0, 10) : "unknown";
    const evidence =
      d.evidence.length === 0
        ? ""
        : `\n_evidence: ${d.evidence
            .slice(0, 6)
            .map((e) => (e.lineRange ? `${e.path}:${e.lineRange[0]}-${e.lineRange[1]}` : e.path))
            .join(", ")}${d.evidence.length > 6 ? ` (+${d.evidence.length - 6})` : ""}_\n`;
    const commits =
      d.sourceCommits.length === 0
        ? ""
        : `_from commits: ${d.sourceCommits.map((s) => s.slice(0, 7)).join(", ")}_\n`;
    const conf = `_confidence: ${d.confidence.toFixed(2)}_\n`;
    return `### [discovery ${d.shortId} - ${dateShort}]
${d.summary}
${evidence}${commits}${conf}`;
  });
  return `## Discoveries\n\n${parts.join("\n\n---\n\n")}`;
}
