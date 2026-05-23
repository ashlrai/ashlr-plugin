/**
 * _genome-issues.ts — surface closed-issue sections in ashlr__grep retrieval.
 *
 * Q3 sibling of _genome-prs.ts. Issue sections are written by
 * scripts/genome-cloud-sync.ts when an `issue_closed` cloud delta arrives.
 * The grep handler calls retrieveIssueSections() so `ashlr__grep "auth bug"`
 * returns the recently-closed issues alongside code + PRs.
 *
 * Mirrors the PR retriever exactly — scans sections/issues/ directly rather
 * than going through the v2 manifest (cloud-sync writes files out-of-band
 * from manifest updates). Best-effort, fails-silent.
 */

import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { type IssueSection, issuesDir } from "./_manifest-v2";
import { scoreSectionMeta, tokenize } from "./_genome-commits";
import { formatFreshness } from "./_genome-freshness";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RetrievedIssue {
  id: string;
  title: string;
  closedAt: string;
  author: string;
  labels: string[];
  summary: string;
  url: string;
  score: number;
}

/**
 * Retrieve up to `limit` issue sections from `sections/issues/` matching `query`.
 *
 * @param cwd        genome root (the directory containing `.ashlrcode/`)
 * @param query      keyword query — same scorer commit/discovery/PR use
 * @param limit      max results (default 3)
 * @param sinceDays  optional freshness filter — drop issues closed longer
 *                   than N days ago. `undefined` disables the filter.
 */
export async function retrieveIssueSections(
  cwd: string,
  query: string,
  limit = 3,
  sinceDays?: number,
): Promise<RetrievedIssue[]> {
  try {
    const dir = issuesDir(cwd);
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

    const loaded: Array<{ section: IssueSection; mtimeMs: number }> = [];
    for (const file of files) {
      const abs = join(dir, file);
      try {
        const [raw, st] = await Promise.all([readFile(abs, "utf-8"), stat(abs)]);
        const section = JSON.parse(raw) as IssueSection;
        if (!section || typeof section !== "object") continue;
        loaded.push({ section, mtimeMs: st.mtimeMs });
      } catch {
        // Skip corrupt file.
      }
    }

    const queryTerms = new Set(tokenize(query));

    const scored = loaded
      .map(({ section, mtimeMs }) => {
        // Freshness filter — drop issues older than the cutoff.
        if (cutoff !== null) {
          const t = section.closedAt ? Date.parse(section.closedAt) : NaN;
          if (Number.isFinite(t) && t < cutoff) {
            return null;
          }
        }
        const tags = [
          "issue",
          "bug",
          section.id,
          ...(section.author ? [section.author.toLowerCase()] : []),
          ...section.labels.map((l) => l.toLowerCase()),
        ];
        const meta = {
          path: `issues/${section.id}.json`,
          title: section.title,
          summary: section.summary,
          tags,
          tokens: Math.ceil((section.title.length + section.summary.length) / 4),
          updatedAt: section.closedAt || new Date(mtimeMs).toISOString(),
        };
        let score: number;
        if (queryTerms.size === 0) {
          score = 1;
        } else {
          score = scoreSectionMeta(meta, queryTerms);
        }
        return { section, score, mtimeMs };
      })
      .filter(
        (x): x is { section: IssueSection; score: number; mtimeMs: number } =>
          x !== null && x.score > 0,
      );

    if (scored.length === 0) return [];

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ad = a.section.closedAt || new Date(a.mtimeMs).toISOString();
      const bd = b.section.closedAt || new Date(b.mtimeMs).toISOString();
      return bd > ad ? 1 : bd < ad ? -1 : 0;
    });

    return scored.slice(0, limit).map(({ section, score }) => ({
      id: section.id,
      title: section.title,
      closedAt: section.closedAt,
      author: section.author,
      labels: section.labels,
      summary: section.summary,
      url: section.url,
      score,
    }));
  } catch {
    return [];
  }
}

/**
 * Format a list of retrieved issue sections as a markdown block. Each
 * issue gets `[Issue #<n> - <date>]` so it reads distinctly from PRs +
 * commits + code in the same response.
 */
export function formatIssuesForPrompt(
  issues: RetrievedIssue[],
  now: Date = new Date(),
): string {
  if (issues.length === 0) return "";
  const parts = issues.map((i) => {
    const dateShort = i.closedAt ? i.closedAt.slice(0, 10) : "unknown";
    const badge = formatFreshness(i.closedAt || undefined, now);
    const badgeFragment = badge ? ` · ${badge.slice(1, -1)}` : "";
    const labels =
      i.labels.length === 0
        ? ""
        : `\n_labels: ${i.labels.slice(0, 6).join(", ")}${
            i.labels.length > 6 ? ` (+${i.labels.length - 6})` : ""
          }_\n`;
    const author = i.author ? `_author: ${i.author}_\n` : "";
    const link = i.url ? `_${i.url}_\n` : "";
    return `### [Issue #${i.id} - ${dateShort}${badgeFragment}] ${i.title}${labels}${author}${link}
${i.summary}`;
  });
  return `## Issues\n\n${parts.join("\n\n---\n\n")}`;
}
