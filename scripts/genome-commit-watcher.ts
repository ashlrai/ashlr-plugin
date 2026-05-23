#!/usr/bin/env bun
/**
 * genome-commit-watcher — local git post-commit hook entry point.
 *
 * Invoked by `.git/hooks/post-commit`. Reads HEAD, produces a commit section,
 * updates the manifest, and prunes the commits directory to the last
 * COMMIT_RETENTION_LIMIT (50) commits by date.
 *
 * Design constraints (Q1 Genome 2.0 MVP):
 *   - Must complete in <1s for a typical commit. No LLM. No AST. Just `git show`.
 *   - Never fails the commit — any error is logged and we exit 0.
 *   - Backward-compatible: v1 manifests auto-upgrade to v2 in-memory on load.
 *
 * Usage:
 *   bun run scripts/genome-commit-watcher.ts [--cwd <dir>] [--sha <sha>]
 *
 * When --sha is omitted we read HEAD via `git rev-parse HEAD`.
 * When --cwd is omitted we use the current working directory.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { readdir, unlink } from "fs/promises";
import { join, resolve } from "path";
import {
  COMMIT_RETENTION_LIMIT,
  commitsDir,
  commitSectionAbsPath,
  loadManifestV2,
  readCommitSectionFile,
  saveManifestV2,
  writeCommitSectionFile,
  type CommitSection,
  type GenomeManifestV2,
  type SectionMetaV2,
} from "../servers/_manifest-v2";

// ---------------------------------------------------------------------------
// Public API (exported for tests)
// ---------------------------------------------------------------------------

export interface WatcherArgs {
  cwd: string;
  sha?: string;
}

export function parseWatcherArgs(argv: string[]): WatcherArgs {
  let cwd = process.cwd();
  let sha: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd" && argv[i + 1]) cwd = resolve(argv[++i]!);
    else if (a === "--sha" && argv[i + 1]) sha = argv[++i];
  }
  return { cwd, sha };
}

/**
 * Run `git` with the given args inside `cwd`. Returns trimmed stdout.
 * Throws on non-zero exit (caller decides whether to swallow).
 */
function git(cwd: string, args: string[]): string {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return out.trim();
}

/**
 * Parse `git show --pretty=fuller --stat <sha>` style output into a structured
 * CommitSection. We split on the first blank line that follows the header
 * (commit / Author / Date / Commit / CommitDate) to extract the message body.
 *
 * Exported for tests — accepts raw `git show` output so we can fixture it.
 */
export function parseCommitSection(
  sha: string,
  showOutput: string,
  statOutput: string,
): CommitSection {
  const lines = showOutput.split("\n");
  let author = "";
  let date = "";
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("Author:")) author = line.slice("Author:".length).trim();
    else if (line.startsWith("AuthorDate:")) date = line.slice("AuthorDate:".length).trim();
    else if (line.startsWith("Date:") && !date) date = line.slice("Date:".length).trim();
    if (line === "" && i > 0) {
      headerEnd = i + 1;
      break;
    }
  }

  // Message body — strip the 4-space indent git applies, stop at next blank-and-stat.
  const bodyLines: string[] = [];
  for (let i = headerEnd; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.startsWith("    ")) bodyLines.push(raw.slice(4));
    else if (raw === "") bodyLines.push("");
    else break;
  }
  const message = bodyLines.join("\n").trim();

  // Files changed — pulled from `git show --stat` output.
  // Format lines look like:  " path/to/file.ts | 12 +++++-----"
  //                          " 3 files changed, 24 insertions(+), 6 deletions(-)"
  const filesChanged: string[] = [];
  for (const raw of statOutput.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/^\s*\d+\s+files?\s+changed/i.test(line)) continue;
    const m = line.match(/^\s*(.+?)\s*\|\s*(?:Bin\b|\d+)/);
    if (m && m[1]) filesChanged.push(m[1].trim());
  }

  // Normalize date to ISO if possible. git author dates look like
  //   "Wed May 22 14:31:09 2026 -0700"  (with --pretty=fuller AuthorDate)
  // We let the JS Date parser handle it; fall back to the raw string.
  let iso = date;
  if (date) {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) iso = parsed.toISOString();
  }

  // Summary body — short message header + diff stat preview.
  const statPreview = statOutput
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 20)
    .join("\n");
  const summary = `# ${message.split("\n")[0] ?? sha.slice(0, 7)}

${message}

## Files changed

\`\`\`
${statPreview}
\`\`\`
`;

  return {
    sha,
    message,
    author,
    date: iso,
    filesChanged,
    summary,
  };
}

/**
 * Read HEAD (or a specific sha) from disk via `git show`.
 * Returns null when not in a git repo or git fails.
 */
export async function readCommitFromGit(cwd: string, sha?: string): Promise<CommitSection | null> {
  try {
    const resolved = sha ?? git(cwd, ["rev-parse", "HEAD"]);
    const show = git(cwd, ["show", "--no-color", "--no-patch", "--pretty=fuller", resolved]);
    const stat = git(cwd, ["show", "--no-color", "--stat", "--pretty=format:", resolved]);
    return parseCommitSection(resolved, show, stat);
  } catch {
    return null;
  }
}

/**
 * Add (or update) a commit section in the genome at `cwd`.
 * Returns the updated manifest, or null when no genome exists.
 *
 * - Writes `.ashlrcode/genome/commits/<sha>.json`.
 * - Upserts a SectionMetaV2 entry in manifest.sections.
 * - Prunes commit sections beyond COMMIT_RETENTION_LIMIT (50) by date.
 */
export async function addCommitSection(
  cwd: string,
  payload: CommitSection,
): Promise<GenomeManifestV2 | null> {
  const manifest = await loadManifestV2(cwd);
  if (!manifest) return null;

  const relPath = await writeCommitSectionFile(cwd, payload);
  const now = new Date().toISOString();
  const firstLine = (payload.message.split("\n")[0] ?? payload.sha.slice(0, 7)).slice(0, 120);

  const meta: SectionMetaV2 = {
    path: relPath,
    title: `commit ${payload.sha.slice(0, 7)} — ${firstLine}`,
    summary: firstLine,
    tags: [
      "commit",
      "diff",
      "history",
      payload.sha.slice(0, 7),
      ...payload.filesChanged.slice(0, 10).map((p) => p.toLowerCase()),
    ],
    tokens: Math.ceil(payload.summary.length / 4),
    updatedAt: now,
    lastUpdatedAt: now,
    sourceTrust: "commit",
    confidence: 0.9, // commit-diffs are high-confidence — straight from git
    kind: "commit",
  };

  const idx = manifest.sections.findIndex((s) => s.path === relPath);
  if (idx >= 0) manifest.sections[idx] = meta;
  else manifest.sections.push(meta);

  // Prune.
  await pruneCommitSections(cwd, manifest);

  await saveManifestV2(cwd, manifest);
  return manifest;
}

/**
 * Keep only the `COMMIT_RETENTION_LIMIT` most recent commit sections.
 *
 * Recency is determined by the CommitSection.date stored in each file
 * (falling back to the manifest entry's updatedAt when the file is unreadable).
 * The manifest is mutated in place — caller is responsible for saving.
 *
 * Returns the SHAs that were pruned (useful for tests + logging).
 */
export async function pruneCommitSections(
  cwd: string,
  manifest: GenomeManifestV2,
): Promise<string[]> {
  const commitMetas = manifest.sections.filter((s) => s.kind === "commit");
  if (commitMetas.length <= COMMIT_RETENTION_LIMIT) return [];

  // Score each by date (newest first). Manifests dating older than the file
  // are tolerated — we use the file's CommitSection.date when present.
  const dated = await Promise.all(
    commitMetas.map(async (m) => {
      const sha = m.path.replace(/^commits\//, "").replace(/\.json$/, "");
      const file = await readCommitSectionFile(cwd, sha).catch(() => null);
      const date = file?.date ?? m.lastUpdatedAt ?? m.updatedAt;
      return { meta: m, sha, date };
    }),
  );
  dated.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  const keep = new Set(dated.slice(0, COMMIT_RETENTION_LIMIT).map((d) => d.meta.path));
  const dropped: string[] = [];
  for (const { meta, sha } of dated) {
    if (keep.has(meta.path)) continue;
    dropped.push(sha);
    const idx = manifest.sections.findIndex((s) => s.path === meta.path);
    if (idx >= 0) manifest.sections.splice(idx, 1);
    const abs = commitSectionAbsPath(cwd, sha);
    if (existsSync(abs)) {
      await unlink(abs).catch(() => {});
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// CLI entry — `bun run scripts/genome-commit-watcher.ts`
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseWatcherArgs(argv);

  // No genome → silently no-op. The git hook is shared with users who
  // haven't opted into a genome yet; we must not error their commits.
  if (!existsSync(join(args.cwd, ".ashlrcode", "genome", "manifest.json"))) {
    return 0;
  }

  // Kill switch — same flag the rest of the genome auto-pipeline honors.
  if (process.env.ASHLR_GENOME_AUTO === "0") return 0;

  try {
    const payload = await readCommitFromGit(args.cwd, args.sha);
    if (!payload) return 0; // not a git repo, or `git show` failed
    await addCommitSection(args.cwd, payload);
  } catch {
    // Never fail the commit. Best-effort only.
  }
  return 0;
}

// Detect direct invocation (vs being imported by tests) and run main().
// Bun sets import.meta.main when the file is the entry point.
if ((import.meta as { main?: boolean }).main) {
  main().then((code) => process.exit(code));
}
