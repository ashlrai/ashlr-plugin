#!/usr/bin/env bun
/**
 * install-genome-hooks — wire the genome commit-watcher into `.git/hooks/post-commit`.
 *
 * Opt-in. Called from `scripts/genome-init.ts` after a successful init (or
 * manually). Idempotent — running it twice is a no-op.
 *
 * Strategy:
 *   1. Locate the git directory (honors `core.hooksPath`).
 *   2. If no post-commit hook exists, write a fresh one that invokes
 *      `bun run scripts/genome-commit-watcher.ts` against the repo root.
 *   3. If a post-commit hook already exists AND already calls the watcher,
 *      do nothing.
 *   4. Otherwise, APPEND a chained block that runs the watcher. We never
 *      overwrite a user's existing hook content.
 *
 * Performance contract: the appended shim runs the watcher in <1s typical.
 * We `&` the watcher to background it so even a degenerate case (cold bun
 * startup) doesn't block the commit. Errors are swallowed via `|| true`.
 *
 * Usage:
 *   bun run scripts/install-genome-hooks.ts [--cwd <dir>] [--force]
 */

import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

export const HOOK_MARKER_BEGIN = "# >>> ashlr genome-commit-watcher >>>";
export const HOOK_MARKER_END = "# <<< ashlr genome-commit-watcher <<<";

export interface InstallerArgs {
  cwd: string;
  force: boolean;
}

export function parseInstallerArgs(argv: string[]): InstallerArgs {
  let cwd = process.cwd();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd" && argv[i + 1]) cwd = resolve(argv[++i]!);
    else if (a === "--force") force = true;
  }
  return { cwd, force };
}

/**
 * Discover the hooks dir for the repo rooted at `cwd`.
 *
 * Honors core.hooksPath (e.g. when a project uses lefthook / husky). Returns
 * null when `cwd` is not inside a git repo.
 *
 * Exported so the installer can be tested against a fixture repo.
 */
export function findHooksDir(cwd: string): string | null {
  try {
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!gitCommonDir) return null;
    const gitDir = resolve(cwd, gitCommonDir);

    // Respect core.hooksPath when set.
    let configured = "";
    try {
      configured = execFileSync("git", ["config", "--get", "core.hooksPath"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      configured = "";
    }
    if (configured) {
      return resolve(cwd, configured);
    }
    return join(gitDir, "hooks");
  } catch {
    return null;
  }
}

/**
 * Render the shell block we inject into post-commit.
 *
 * The shim resolves the watcher path relative to the repo root (passed as
 * argument) so it works regardless of where the user runs git from.
 */
export function renderHookBlock(repoRoot: string, watcherPath: string): string {
  const rel = relative(repoRoot, watcherPath) || "scripts/genome-commit-watcher.ts";
  return [
    HOOK_MARKER_BEGIN,
    "# Auto-installed by scripts/install-genome-hooks.ts — see that file for details.",
    "# Backgrounded + best-effort so it never blocks or fails a commit.",
    `if command -v bun >/dev/null 2>&1; then`,
    `  ( cd "$(git rev-parse --show-toplevel)" && bun run "${rel}" >/dev/null 2>&1 & ) || true`,
    `fi`,
    HOOK_MARKER_END,
  ].join("\n");
}

export interface InstallResult {
  installed: boolean;
  /** Reason for skipping when installed === false. */
  reason?: "no-git" | "already-installed";
  hookPath?: string;
}

/**
 * Install (or re-install) the post-commit hook for the repo at `cwd`.
 *
 * Idempotent: if the marker block is already present, returns
 * `{ installed: false, reason: "already-installed" }`.
 *
 * When --force is passed we replace any existing marker block with a fresh one.
 */
export function installPostCommitHook(args: InstallerArgs): InstallResult {
  const hooksDir = findHooksDir(args.cwd);
  if (!hooksDir) return { installed: false, reason: "no-git" };

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = join(hooksDir, "post-commit");
  const watcherAbs = resolve(args.cwd, "scripts", "genome-commit-watcher.ts");
  const block = renderHookBlock(args.cwd, watcherAbs);

  let existing = "";
  if (existsSync(hookPath)) {
    existing = readFileSync(hookPath, "utf-8");
  }

  const hasMarker = existing.includes(HOOK_MARKER_BEGIN);

  if (hasMarker && !args.force) {
    return { installed: false, reason: "already-installed", hookPath };
  }

  let next: string;
  if (!existing.trim()) {
    // Fresh hook — write a complete shebang script.
    next = `#!/usr/bin/env bash\n# Managed in part by ashlr-plugin. Custom logic below the marker is preserved.\n\n${block}\n`;
  } else if (hasMarker) {
    // Replace the marker block (force path).
    const re = new RegExp(
      `${escapeRegex(HOOK_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_MARKER_END)}\\n?`,
      "g",
    );
    next = existing.replace(re, `${block}\n`);
  } else {
    // Chain — append at the end, preserving any existing logic above.
    const sep = existing.endsWith("\n") ? "" : "\n";
    next = `${existing}${sep}\n${block}\n`;
  }

  writeFileSync(hookPath, next, "utf-8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // chmod may fail on Windows — the file is still written.
  }
  return { installed: true, hookPath };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseInstallerArgs(argv);
  const res = installPostCommitHook(args);
  if (res.installed) {
    // eslint-disable-next-line no-console
    console.log(`installed post-commit hook → ${res.hookPath}`);
    return 0;
  }
  if (res.reason === "no-git") {
    console.error("not a git repo — skipped");
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log(`post-commit hook already installed at ${res.hookPath}`);
  return 0;
}

if ((import.meta as { main?: boolean }).main) {
  process.exit(main());
}
