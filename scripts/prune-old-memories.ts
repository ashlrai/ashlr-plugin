#!/usr/bin/env bun
/**
 * prune-old-memories.ts — surface auto-memory entries (under
 * `<claude-projects-dir>/memory/`) that are stale candidates for deletion.
 *
 * Read-only by default — prints a candidate report and exits 0. Pass
 * `--apply` to actually delete the flagged files.
 *
 * Heuristics for "candidate":
 *   1. File has not been modified in > N days (default: 30; --days=N to override)
 *   2. There is a NEWER entry whose name starts with the same project_v<major>
 *      prefix (e.g. project_v1.13_*.md is superseded by project_v1.14_*.md)
 *   3. Or the entry's title contains an explicit "(superseded ...)" marker
 *
 * Usage:
 *   bun run scripts/prune-old-memories.ts                       # report only
 *   bun run scripts/prune-old-memories.ts --days=60             # 60-day cutoff
 *   bun run scripts/prune-old-memories.ts --dir=/path/to/memory # explicit dir
 *   bun run scripts/prune-old-memories.ts --apply               # actually delete
 *
 * Files removed are also removed from MEMORY.md if a single-line link to them
 * is found (`- [.*](filename.md) — ...`).
 *
 * This is a hygiene tool — never run automatically. Operator-driven.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

interface PruneCandidate {
  path: string;
  name: string;
  ageDays: number;
  reason: string;
}

function parseArgs(argv: string[]): { dir?: string; days: number; apply: boolean } {
  const out = { days: 30, apply: false } as { dir?: string; days: number; apply: boolean };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--days=")) out.days = parseInt(a.slice("--days=".length), 10) || 30;
    else if (a.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
  }
  return out;
}

/** Find the default Claude Code project memory directory for this CWD. */
function defaultMemoryDir(): string | null {
  const home = process.env.HOME ?? homedir();
  const cwd = process.cwd();
  // Convention: <home>/.claude/projects/<encoded-cwd>/memory/
  // The encoding replaces / with -, e.g. /Users/masonwyatt/foo → -Users-masonwyatt-foo
  const encoded = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  const dir = join(home, ".claude", "projects", encoded, "memory");
  if (existsSync(dir)) return dir;
  return null;
}

function listMemoryFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
}

/** Extract the version-major prefix from a project memory filename. e.g. "project_v123_..." → "v123" */
function versionPrefix(name: string): string | null {
  const m = name.match(/^project_v(\d+(?:[a-z\d_]*)?)/i);
  return m ? `v${m[1]!.split("_")[0]!}` : null;
}

/** Compare two project memory entries by version prefix (semver-ish). */
function compareVersions(a: string, b: string): number {
  // Strip non-digit suffix and compare numerically
  const an = parseInt(a.replace(/[^\d]/g, ""), 10);
  const bn = parseInt(b.replace(/[^\d]/g, ""), 10);
  return an - bn;
}

function findCandidates(dir: string, days: number): PruneCandidate[] {
  const files = listMemoryFiles(dir);
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  // Group by major-version prefix
  const byPrefix = new Map<string, Array<{ file: string; mtime: number }>>();
  for (const file of files) {
    const full = join(dir, file);
    const mtime = statSync(full).mtimeMs;
    const prefix = versionPrefix(file);
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push({ file, mtime });
  }

  // For each prefix group, find the newest version. Older same-prefix files are candidates.
  const candidates: PruneCandidate[] = [];
  // Sort prefixes by version number; older versions whose newer-version sibling exists are candidates.
  const prefixes = [...byPrefix.keys()].sort(compareVersions);
  for (let i = 0; i < prefixes.length - 1; i++) {
    const olderPrefix = prefixes[i]!;
    const newerPrefix = prefixes[i + 1]!;
    const olderEntries = byPrefix.get(olderPrefix) ?? [];
    for (const { file, mtime } of olderEntries) {
      if (mtime > cutoff) continue;
      const ageDays = Math.round((now - mtime) / (24 * 60 * 60 * 1000));
      candidates.push({
        path: join(dir, file),
        name: file,
        ageDays,
        reason: `superseded by ${newerPrefix}_*.md (older than ${days}d cutoff)`,
      });
    }
  }

  // Also flag any file with an explicit "(superseded" marker in its body
  for (const file of files) {
    const full = join(dir, file);
    const mtime = statSync(full).mtimeMs;
    if (mtime > cutoff) continue;
    let content = "";
    try { content = readFileSync(full, "utf-8"); } catch { continue; }
    if (/\(superseded by/i.test(content) && !candidates.some((c) => c.path === full)) {
      const ageDays = Math.round((now - mtime) / (24 * 60 * 60 * 1000));
      candidates.push({
        path: full,
        name: file,
        ageDays,
        reason: `body contains "(superseded by ...)" marker`,
      });
    }
  }

  return candidates;
}

function pruneFromIndex(memoryDir: string, removedNames: string[]): number {
  const indexPath = join(memoryDir, "MEMORY.md");
  if (!existsSync(indexPath)) return 0;
  const lines = readFileSync(indexPath, "utf-8").split("\n");
  const removedSet = new Set(removedNames);
  const kept: string[] = [];
  let pruned = 0;
  for (const line of lines) {
    const m = line.match(/\(([^)]+\.md)\)/);
    if (m && removedSet.has(basename(m[1]!))) {
      pruned++;
      continue;
    }
    kept.push(line);
  }
  if (pruned > 0) {
    writeFileSync(indexPath, kept.join("\n"));
  }
  return pruned;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir ?? defaultMemoryDir();
  if (!dir || !existsSync(dir)) {
    process.stderr.write(
      `prune-old-memories: no memory dir found.\n` +
      `Try: bun run scripts/prune-old-memories.ts --dir=<path>\n` +
      `Default location: ~/.claude/projects/<encoded-cwd>/memory/\n`,
    );
    process.exit(1);
  }

  const candidates = findCandidates(dir, args.days);

  if (candidates.length === 0) {
    process.stdout.write(`prune-old-memories: no candidates older than ${args.days} days found in ${dir}\n`);
    return;
  }

  process.stdout.write(`prune-old-memories: ${candidates.length} candidate(s) older than ${args.days} days in:\n`);
  process.stdout.write(`  ${dir}\n\n`);
  for (const c of candidates) {
    process.stdout.write(`  • ${c.name}  (${c.ageDays}d old)\n`);
    process.stdout.write(`      reason: ${c.reason}\n`);
  }

  if (!args.apply) {
    process.stdout.write(`\nDry run — no files removed. Re-run with --apply to delete + remove from MEMORY.md.\n`);
    return;
  }

  // Apply mode
  let removed = 0;
  const removedNames: string[] = [];
  for (const c of candidates) {
    try {
      unlinkSync(c.path);
      removed++;
      removedNames.push(c.name);
    } catch (e) {
      process.stderr.write(`  ✗ failed to delete ${c.name}: ${(e as Error).message}\n`);
    }
  }
  const indexPruned = pruneFromIndex(dir, removedNames);
  process.stdout.write(`\nremoved ${removed} memory file(s); pruned ${indexPruned} MEMORY.md entry(ies).\n`);
}

if (import.meta.main) {
  void main();
}

// Re-export for testing
export { findCandidates, defaultMemoryDir, parseArgs, versionPrefix };
