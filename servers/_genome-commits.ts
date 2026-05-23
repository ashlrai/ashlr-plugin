/**
 * _genome-commits.ts — surface commit sections in ashlr__grep retrieval.
 *
 * Loads commit sections from the v2 manifest, scores them against a query
 * with the same lightweight keyword scorer the static-section retriever
 * uses (tags > title > summary, IDF-ish boost), and returns a small
 * sorted slice for the grep handler to prepend to its output.
 *
 * Commit sections are ADDITIVE — they extend the corpus, never replace it.
 * The grep handler formats them with a distinct `[commit <sha> - <date>]`
 * prefix so users can tell history from static code.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  type CommitSection,
  type GenomeManifestV2,
  type SectionMetaV2,
  loadManifestV2,
  commitSectionAbsPath,
} from "./_manifest-v2";

// ---------------------------------------------------------------------------
// Tokenization + scoring (mirrors core-efficiency/genome/retriever.ts)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreCommit(meta: SectionMetaV2, queryTerms: Set<string>): number {
  let score = 0;
  const tagSet = new Set(meta.tags.map((t) => t.toLowerCase()));
  const titleTerms = new Set(tokenize(meta.title));
  const summaryTerms = new Set(tokenize(meta.summary));
  for (const term of queryTerms) {
    if (tagSet.has(term)) score += 3;
    if (titleTerms.has(term)) score += 2;
    if (summaryTerms.has(term)) score += 1;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RetrievedCommit {
  sha: string;
  shortSha: string;
  date: string;
  message: string;
  summary: string;
  filesChanged: string[];
  score: number;
}

/**
 * Retrieve up to `limit` commit sections matching `query`.
 *
 * Returns an empty array when:
 *   - no genome exists,
 *   - the manifest is v1-only (no commit sections recorded),
 *   - no commit section's keywords overlap the query.
 *
 * Never throws — best-effort retrieval, callers should fall through to
 * static-section results when this returns [].
 */
export async function retrieveCommitSections(
  cwd: string,
  query: string,
  limit = 3,
): Promise<RetrievedCommit[]> {
  try {
    const manifest = await loadManifestV2(cwd);
    if (!manifest) return [];

    const commitMetas = manifest.sections.filter((s) => s.kind === "commit");
    if (commitMetas.length === 0) return [];

    const queryTerms = new Set(tokenize(query));
    let scored: Array<{ meta: SectionMetaV2; score: number }>;

    if (queryTerms.size === 0) {
      // No meaningful query — surface the most recent commits.
      scored = commitMetas.map((m) => ({ meta: m, score: 1 }));
    } else {
      scored = commitMetas
        .map((m) => ({ meta: m, score: scoreCommit(m, queryTerms) }))
        .filter((s) => s.score > 0);
    }

    if (scored.length === 0) return [];

    // Sort by score desc, then date desc (most recent wins ties).
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ad = a.meta.lastUpdatedAt ?? a.meta.updatedAt;
      const bd = b.meta.lastUpdatedAt ?? b.meta.updatedAt;
      return bd > ad ? 1 : bd < ad ? -1 : 0;
    });

    const out: RetrievedCommit[] = [];
    for (const { meta, score } of scored.slice(0, limit)) {
      const sha = meta.path.replace(/^commits\//, "").replace(/\.json$/, "");
      const abs = commitSectionAbsPath(cwd, sha);
      if (!existsSync(abs)) continue;
      let payload: CommitSection;
      try {
        payload = JSON.parse(await readFile(abs, "utf-8")) as CommitSection;
      } catch {
        continue;
      }
      out.push({
        sha: payload.sha,
        shortSha: payload.sha.slice(0, 7),
        date: payload.date,
        message: payload.message,
        summary: payload.summary,
        filesChanged: payload.filesChanged,
        score,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Format a list of retrieved commit sections as a markdown block suitable for
 * prepending to grep output. Each commit is clearly labeled with
 * `[commit <sha> - <date>]` so the user knows it's history, not static code.
 */
export function formatCommitsForPrompt(commits: RetrievedCommit[]): string {
  if (commits.length === 0) return "";
  const parts = commits.map((c) => {
    const dateShort = c.date ? c.date.slice(0, 10) : "unknown";
    const files =
      c.filesChanged.length === 0
        ? ""
        : `\n_files: ${c.filesChanged.slice(0, 6).join(", ")}${c.filesChanged.length > 6 ? ` (+${c.filesChanged.length - 6})` : ""}_\n`;
    const subject = c.message.split("\n")[0] ?? c.shortSha;
    return `### [commit ${c.shortSha} - ${dateShort}] ${subject}${files}
${c.summary}`;
  });
  return `## Commit History\n\n${parts.join("\n\n---\n\n")}`;
}
