/**
 * _genome-prs.ts — surface merged-PR sections in ashlr__grep retrieval.
 *
 * Q3 cousin of _genome-commits.ts. PR sections are written by
 * scripts/genome-cloud-sync.ts when a `pr_merged` cloud delta arrives. The
 * grep handler calls retrievePrSections() to surface relevant merged PRs
 * alongside code matches — so `ashlr__grep "auth bug"` can return both the
 * code and the PR that recently fixed it.
 *
 * Unlike commits + discoveries (which gate retrieval on the v2 manifest),
 * PR retrieval scans the on-disk `sections/prs/` directory directly because
 * cloud-sync writes those files OUT-OF-BAND from the manifest. This keeps
 * the cloud path simple — no manifest mutation per delta — and means
 * retrieval still works when a teammate runs `ashlr-genome-pull` and then
 * immediately greps before the next save bumps the manifest.
 *
 * Best-effort, fails-silent. Any I/O failure returns [].
 */

import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { type PrSection, prsDir } from "./_manifest-v2";
import { scoreSectionMeta, tokenize } from "./_genome-commits";
import { formatFreshness } from "./_genome-freshness";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RetrievedPr {
  id: string;
  title: string;
  mergedAt: string;
  author: string;
  filesChanged: string[];
  summary: string;
  url: string;
  score: number;
}

/**
 * Retrieve up to `limit` PR sections from `sections/prs/` matching `query`.
 *
 * @param cwd        genome root (the directory containing `.ashlrcode/`)
 * @param query      keyword query — same scorer the commit + discovery
 *                   retrievers use (tag/title/summary weighted)
 * @param limit      max results (default 3)
 * @param sinceDays  optional freshness filter — drop PRs merged longer than
 *                   N days ago. `undefined` disables the filter.
 *
 * Returns [] when no PRs match, when the dir doesn't exist, when the
 * manifest is missing — never throws.
 */
export async function retrievePrSections(
  cwd: string,
  query: string,
  limit = 3,
  sinceDays?: number,
): Promise<RetrievedPr[]> {
  try {
    const dir = prsDir(cwd);
    if (!existsSync(dir)) return [];

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const files = entries.filter((n) => n.endsWith(".json"));
    if (files.length === 0) return [];

    const cutoff =
      typeof sinceDays === "number" && Number.isFinite(sinceDays) && sinceDays > 0
        ? Date.now() - sinceDays * 24 * 60 * 60 * 1000
        : null;

    // Load every PR file. The retention limit caps this at PR_RETENTION_LIMIT
    // (100 default) so even a full scan is cheap. We deliberately don't
    // route through the v2 manifest: cloud-sync writes PR files out-of-band
    // (no manifest update per delta) so the manifest may not yet list them.
    const loaded: Array<{ section: PrSection; mtimeMs: number }> = [];
    for (const file of files) {
      const abs = join(dir, file);
      try {
        const [raw, st] = await Promise.all([readFile(abs, "utf-8"), stat(abs)]);
        const section = JSON.parse(raw) as PrSection;
        if (!section || typeof section !== "object") continue;
        loaded.push({ section, mtimeMs: st.mtimeMs });
      } catch {
        // Skip corrupt file, keep going.
      }
    }

    const queryTerms = new Set(tokenize(query));

    // Build a SectionMetaV2-shaped object on the fly so we can reuse the
    // same scorer the commit + discovery retrievers use. Tags pull from the
    // PR author + filesChanged so file-path queries can still hit ("login"
    // → tag "auth/login.ts" → score boost).
    const scored = loaded
      .map(({ section, mtimeMs }) => {
        // Freshness filter — drop PRs older than the cutoff.
        if (cutoff !== null) {
          const t = section.mergedAt ? Date.parse(section.mergedAt) : NaN;
          if (Number.isFinite(t) && t < cutoff) {
            return null;
          }
        }
        const tags = [
          "pr",
          "pull-request",
          section.id,
          ...(section.author ? [section.author.toLowerCase()] : []),
          ...section.filesChanged.slice(0, 10).map((p) => p.toLowerCase()),
        ];
        const meta = {
          path: `prs/${section.id}.json`,
          title: section.title,
          summary: section.summary,
          tags,
          tokens: Math.ceil((section.title.length + section.summary.length) / 4),
          updatedAt: section.mergedAt || new Date(mtimeMs).toISOString(),
        };
        let score: number;
        if (queryTerms.size === 0) {
          // No meaningful query — surface the most recently merged PRs.
          score = 1;
        } else {
          score = scoreSectionMeta(meta, queryTerms);
        }
        return { section, score, mtimeMs };
      })
      .filter((x): x is { section: PrSection; score: number; mtimeMs: number } => x !== null && x.score > 0);

    if (scored.length === 0) return [];

    // Sort by score desc, then mergedAt desc (most recent wins ties).
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ad = a.section.mergedAt || new Date(a.mtimeMs).toISOString();
      const bd = b.section.mergedAt || new Date(b.mtimeMs).toISOString();
      return bd > ad ? 1 : bd < ad ? -1 : 0;
    });

    return scored.slice(0, limit).map(({ section, score }) => ({
      id: section.id,
      title: section.title,
      mergedAt: section.mergedAt,
      author: section.author,
      filesChanged: section.filesChanged,
      summary: section.summary,
      url: section.url,
      score,
    }));
  } catch {
    return [];
  }
}

/**
 * Format a list of retrieved PR sections as a markdown block suitable for
 * prepending to grep output. Each PR gets a distinct `[PR #<n> - <date>]`
 * header so the model + user know it's GitHub history, not static code.
 *
 * Freshness badge is decorated when mergedAt parses. Matches the
 * `_genome-commits` formatter conventions.
 */
export function formatPrsForPrompt(prs: RetrievedPr[], now: Date = new Date()): string {
  if (prs.length === 0) return "";
  const parts = prs.map((p) => {
    const dateShort = p.mergedAt ? p.mergedAt.slice(0, 10) : "unknown";
    const badge = formatFreshness(p.mergedAt || undefined, now);
    const badgeFragment = badge ? ` · ${badge.slice(1, -1)}` : "";
    const files =
      p.filesChanged.length === 0
        ? ""
        : `\n_files: ${p.filesChanged.slice(0, 6).join(", ")}${
            p.filesChanged.length > 6 ? ` (+${p.filesChanged.length - 6})` : ""
          }_\n`;
    const author = p.author ? `_author: ${p.author}_\n` : "";
    const link = p.url ? `_${p.url}_\n` : "";
    return `### [PR #${p.id} - ${dateShort}${badgeFragment}] ${p.title}${files}${author}${link}
${p.summary}`;
  });
  return `## Pull Requests\n\n${parts.join("\n\n---\n\n")}`;
}
