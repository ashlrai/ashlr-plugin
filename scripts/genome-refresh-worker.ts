#!/usr/bin/env bun
/**
 * genome-refresh-worker.ts — Incremental genome refresh for edited files.
 *
 * Reads ~/.ashlr/pending-genome-refresh.txt, groups paths by their genome
 * root, and incrementally refreshes affected genome sections using the
 * in-process _genome-live refresh logic. Clears the pending list on success.
 *
 * Usage:
 *   bun run scripts/genome-refresh-worker.ts [--full] [--dry-run] [--quiet]
 *
 *   --full      Force a full genome rebuild (re-runs genome-init for each
 *               project). WARNING: may trigger LLM summarization if Ollama is
 *               available. Use sparingly.
 *   --dry-run   Print what would be refreshed, but don't write anything.
 *   --quiet     Suppress all output (used when invoked from session-end hook).
 *
 * Design rules:
 *   - Incremental refresh by default — never full LLM-rebuilds unless --full.
 *   - Kill switch: ASHLR_GENOME_AUTO=0 exits immediately.
 *   - Never throws — exits 0 always.
 *   - Safe to run concurrently (pending-file write uses atomic rename when possible).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname, resolve, isAbsolute } from "path";

import { genomeExists } from "@ashlr/core-efficiency/genome";
import { refreshGenomeAfterEdit } from "../servers/_genome-live";
import { PENDING_FILE_NAME } from "../hooks/posttooluse-genome-refresh";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum ms since last pending-file write before triggering refresh. */
const DEBOUNCE_MS_DEFAULT = 2_000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface WorkerArgs {
  full: boolean;
  dryRun: boolean;
  quiet: boolean;
  debounceMs: number;
  home: string;
}

export function parseArgs(argv: string[]): WorkerArgs {
  let full = false;
  let dryRun = false;
  let quiet = false;
  let debounceMs = DEBOUNCE_MS_DEFAULT;
  let home = homedir();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") full = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--quiet") quiet = true;
    else if (a === "--debounce" && argv[i + 1]) {
      debounceMs = parseInt(argv[++i], 10) || DEBOUNCE_MS_DEFAULT;
    } else if (a === "--home" && argv[i + 1]) {
      home = argv[++i];
    }
  }

  return { full, dryRun, quiet, debounceMs, home };
}

// ---------------------------------------------------------------------------
// Pending-file helpers
// ---------------------------------------------------------------------------

export function pendingFilePath(home: string): string {
  return join(home, ".ashlr", PENDING_FILE_NAME);
}

/** Read pending file and return deduped absolute paths. */
export function readPendingPaths(home: string): string[] {
  const file = pendingFilePath(home);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    const seen = new Set<string>();
    for (const line of lines) {
      const t = line.trim();
      if (t) {
        const abs = isAbsolute(t) ? t : resolve(t);
        seen.add(abs);
      }
    }
    return [...seen];
  } catch {
    return [];
  }
}

/** Clear the pending file. */
export function clearPendingFile(home: string): void {
  const file = pendingFilePath(home);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Genome root resolution
// ---------------------------------------------------------------------------

const MAX_WALK = 8;

/** Walk up from `startDir` to find a directory containing .ashlrcode/genome/. */
export function findGenomeRoot(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i <= MAX_WALK; i++) {
    if (genomeExists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Group file paths by their genome root. Paths with no genome root are dropped. */
export function groupByGenomeRoot(
  paths: string[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of paths) {
    const dir = dirname(p);
    const root = findGenomeRoot(dir);
    if (!root) continue;
    const list = map.get(root) ?? [];
    list.push(p);
    map.set(root, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Debounce check
// ---------------------------------------------------------------------------

/**
 * Return true when the pending file is "settled" — its mtime is older than
 * `debounceMs`. If the file doesn't exist or we can't stat it, return true
 * (nothing to debounce).
 */
export async function isDebounced(home: string, debounceMs: number): Promise<boolean> {
  const file = pendingFilePath(home);
  if (!existsSync(file)) return true;
  try {
    const s = await stat(file);
    const ageMs = Date.now() - s.mtimeMs;
    return ageMs >= debounceMs;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Incremental refresh
// ---------------------------------------------------------------------------

export interface RefreshSummary {
  filesProcessed: number;
  sectionsUpdated: number;
  sectionsInvalidated: number;
  genomeRoots: string[];
}

/**
 * Incrementally refresh genome sections for the given file paths.
 *
 * For each file, calls refreshGenomeAfterEdit with empty before/after strings.
 * With empty editBefore, the live-refresh logic will not find any verbatim
 * match, causing it to check all sections that reference the file by name and
 * invalidate them — which is the correct behavior for an "unknown what changed"
 * refresh: mark the section stale so the propose queue can regenerate it.
 *
 * This is intentionally conservative: we never guess at content, we just
 * invalidate anything that references the file.
 */
export async function refreshPaths(
  paths: string[],
  opts: { dryRun?: boolean; quiet?: boolean } = {},
): Promise<RefreshSummary> {
  const summary: RefreshSummary = {
    filesProcessed: 0,
    sectionsUpdated: 0,
    sectionsInvalidated: 0,
    genomeRoots: [],
  };

  const grouped = groupByGenomeRoot(paths);
  for (const root of grouped.keys()) {
    if (!summary.genomeRoots.includes(root)) {
      summary.genomeRoots.push(root);
    }
  }

  if (opts.dryRun) {
    if (!opts.quiet) {
      const total = paths.length;
      const roots = summary.genomeRoots.length;
      process.stderr.write(
        `[genome-refresh-worker] dry-run: would refresh ${total} file(s) across ${roots} genome root(s)\n`,
      );
      for (const [root, filePaths] of grouped) {
        process.stderr.write(`  genome: ${root}\n`);
        for (const p of filePaths) process.stderr.write(`    ${p}\n`);
      }
    }
    return summary;
  }

  for (const [, filePaths] of grouped) {
    for (const filePath of filePaths) {
      try {
        // Pass empty strings: refreshGenomeAfterEdit will find sections that
        // reference this file (by filename/path) and invalidate them since
        // no verbatim match exists for "". This is the incremental-stale path.
        const result = await refreshGenomeAfterEdit(filePath, "", "");
        summary.filesProcessed++;
        summary.sectionsUpdated += result.updated;
        summary.sectionsInvalidated += result.skipped;
      } catch {
        /* individual file failures don't stop the batch */
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Full rebuild
// ---------------------------------------------------------------------------

/**
 * Trigger a full genome rebuild for each affected genome root.
 * Calls genome-init.ts with --force --minimal so it skips LLM summarization.
 * The caller can pass --full explicitly to also run Ollama summarization.
 */
export async function fullRebuild(
  genomeRoots: string[],
  opts: { quiet?: boolean; dryRun?: boolean } = {},
): Promise<void> {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const initScript = join(scriptDir, "genome-init.ts");

  if (!existsSync(initScript)) {
    if (!opts.quiet)
      process.stderr.write("[genome-refresh-worker] genome-init.ts not found — skipping full rebuild\n");
    return;
  }

  for (const root of genomeRoots) {
    if (!opts.quiet)
      process.stderr.write(`[genome-refresh-worker] full rebuild: ${root}\n`);
    if (opts.dryRun) continue;

    try {
      const proc = Bun.spawn(
        ["bun", "run", initScript, "--dir", root, "--force", "--minimal"],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      await proc.exited;
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(args: WorkerArgs): Promise<RefreshSummary> {
  // Kill switch
  if (process.env.ASHLR_GENOME_AUTO === "0") {
    return {
      filesProcessed: 0,
      sectionsUpdated: 0,
      sectionsInvalidated: 0,
      genomeRoots: [],
    };
  }

  const paths = readPendingPaths(args.home);
  if (paths.length === 0) {
    if (!args.quiet) process.stderr.write("[genome-refresh-worker] no pending files\n");
    return {
      filesProcessed: 0,
      sectionsUpdated: 0,
      sectionsInvalidated: 0,
      genomeRoots: [],
    };
  }

  // Debounce: only proceed if the pending file is settled.
  const settled = await isDebounced(args.home, args.debounceMs);
  if (!settled) {
    if (!args.quiet)
      process.stderr.write(
        `[genome-refresh-worker] debouncing — pending file was written < ${args.debounceMs}ms ago\n`,
      );
    return {
      filesProcessed: 0,
      sectionsUpdated: 0,
      sectionsInvalidated: 0,
      genomeRoots: [],
    };
  }

  if (args.full) {
    // Full rebuild path: identify genome roots, then re-init each one.
    const grouped = groupByGenomeRoot(paths);
    const roots = [...grouped.keys()];
    await fullRebuild(roots, { quiet: args.quiet, dryRun: args.dryRun });
    if (!args.dryRun) clearPendingFile(args.home);
    return {
      filesProcessed: paths.length,
      sectionsUpdated: 0,
      sectionsInvalidated: 0,
      genomeRoots: roots,
    };
  }

  // Incremental path
  const summary = await refreshPaths(paths, {
    dryRun: args.dryRun,
    quiet: args.quiet,
  });

  if (!args.dryRun) {
    clearPendingFile(args.home);
  }

  if (!args.quiet) {
    process.stderr.write(
      `[genome-refresh-worker] done: ${summary.filesProcessed} files, ` +
        `${summary.sectionsUpdated} updated, ${summary.sectionsInvalidated} invalidated, ` +
        `${summary.genomeRoots.length} genome root(s)\n`,
    );
  }

  return summary;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  run(args).finally(() => process.exit(0));
}
