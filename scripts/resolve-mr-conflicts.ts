#!/usr/bin/env bun
/**
 * Usage: bun scripts/resolve-mr-conflicts.ts [path ...]
 *
 * Deterministically resolves lane-side merge/rebase conflicts — no model
 * calls. Run inside a worktree stopped at a conflict; with no path arguments
 * it resolves every unmerged path it knows how to handle. Paths, when given,
 * must be repo-relative.
 *
 *   CHANGELOG.md / CLAUDE.md / README.md → three-way union merge of the index
 *     stages: the onto-branch version (stage #2, i.e. main during `git rebase
 *     main`) with the PR's own hunks kept. Union is the same resolution the
 *     `merge=union` driver applies to CHANGELOG.md, so this also covers clones
 *     where .gitattributes was absent and hosts (GitHub) that ignore custom
 *     merge drivers for server-side merges.
 *   bun.lock / package-lock.json / Cargo.lock → never hand-merged: the base
 *     lockfile (stage #2) is checked out, then the package manager
 *     regenerates it — frozen/locked mode first so resolved versions are only
 *     re-pinned when the merged manifest actually diverged. A lockfile whose
 *     sibling manifest is still conflicted is deferred for a later run.
 *
 * Resolved paths are printed to stdout and staged. Anything else stays
 * conflicted, is reported on stderr and exits 1.
 * PM binaries default to bun/npm/cargo; override with ASHLR_PM_BUN /
 * ASHLR_PM_NPM / ASHLR_PM_CARGO (used by tests).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const UNION_DOCS = new Set(["CHANGELOG.md", "CLAUDE.md", "README.md"]);

interface LockfileRule {
  manifest: string;
  pmEnv: string;
  pm: string;
  /** Argument lists tried in order until one exits 0. */
  attempts: string[][];
}

const LOCKFILES: Record<string, LockfileRule> = {
  "bun.lock": {
    manifest: "package.json", pmEnv: "ASHLR_PM_BUN", pm: "bun",
    attempts: [
      ["install", "--frozen-lockfile", "--lockfile-only"],
      ["install", "--lockfile-only"],
    ],
  },
  "package-lock.json": {
    manifest: "package.json", pmEnv: "ASHLR_PM_NPM", pm: "npm",
    attempts: [["install", "--package-lock-only", "--ignore-scripts"]],
  },
  "Cargo.lock": {
    manifest: "Cargo.toml", pmEnv: "ASHLR_PM_CARGO", pm: "cargo",
    attempts: [["generate-lockfile", "--locked"], ["generate-lockfile"]],
  },
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function unmerged(root: string): string[] {
  const out = git(root, ["diff", "--name-only", "--diff-filter=U", "-z", "--"]);
  return out.split("\0").filter(Boolean);
}

/** Blob at an index stage, or null when the stage does not exist. */
function stage(root: string, n: 1 | 2 | 3, path: string): Buffer | null {
  try {
    return execFileSync("git", ["cat-file", "-p", `:${n}:${path}`], {
      cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/** Union-merge the index stages for path: stage #2 wins position, #3's hunks are kept. */
export function resolveUnion(root: string, path: string): boolean {
  const ours = stage(root, 2, path);
  const theirs = stage(root, 3, path);
  if (!ours && !theirs) return false;
  const tmp = mkdtempSync(join(tmpdir(), "mr-conflict-"));
  try {
    const files = { ours: join(tmp, "ours"), base: join(tmp, "base"), theirs: join(tmp, "theirs") };
    writeFileSync(files.ours, ours ?? "");
    writeFileSync(files.base, stage(root, 1, path) ?? "");
    writeFileSync(files.theirs, theirs ?? "");
    const merged = execFileSync(
      "git", ["merge-file", "--union", "-p", files.ours, files.base, files.theirs],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    writeFileSync(join(root, path), merged);
    git(root, ["add", "--", path]);
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Check out the base lockfile (stage #2) and regenerate it with the package manager. */
export function resolveLockfile(root: string, path: string, rule: LockfileRule, pending: Set<string>): boolean {
  const dir = dirname(path);
  const manifest = dir === "." ? rule.manifest : `${dir}/${rule.manifest}`;
  if (pending.has(manifest)) return false; // Manifest unresolved; regenerate on a later run.
  try {
    git(root, ["checkout", "--ours", "--", path]);
  } catch {
    return false;
  }
  const pm = process.env[rule.pmEnv] ?? rule.pm;
  for (const args of rule.attempts) {
    try {
      execFileSync(pm, args, { cwd: join(root, dir), stdio: ["ignore", "pipe", "pipe"] });
      git(root, ["add", "--", path]);
      return true;
    } catch {
      // Next attempt; all attempts failing leaves the path unresolved.
    }
  }
  return false;
}

export function resolveConflicts(root: string, paths: string[]): { resolved: string[]; unresolved: string[] } {
  const pending = new Set(unmerged(root));
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const path of paths) {
    if (!pending.has(path)) {
      unresolved.push(path);
      continue;
    }
    const rule = LOCKFILES[basename(path)];
    const ok = rule
      ? resolveLockfile(root, path, rule, pending)
      : UNION_DOCS.has(basename(path)) && resolveUnion(root, path);
    if (ok) {
      resolved.push(path);
      pending.delete(path);
    } else {
      unresolved.push(path);
    }
  }
  return { resolved, unresolved };
}

if (import.meta.main) {
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const pending = unmerged(root);
    const args = process.argv.slice(2);
    const bad = args.find(arg => !arg || arg.startsWith("/") || arg.split("/").includes(".."));
    if (bad) throw new Error(`resolve-mr-conflicts: invalid repo-relative path ${bad}`);
    const targets = args.length ? args : pending;
    const { resolved, unresolved } = resolveConflicts(root, targets);
    for (const path of resolved) console.log(path);
    for (const path of unresolved) {
      console.error(`resolve-mr-conflicts: left conflicted: ${path}`);
    }
    if (unresolved.length) process.exitCode = 1;
  } catch (error) {
    console.error(`resolve-mr-conflicts: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
