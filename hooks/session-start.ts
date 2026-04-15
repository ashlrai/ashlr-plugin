#!/usr/bin/env bun
/**
 * ashlr SessionStart hook (TypeScript).
 *
 * Replaces the legacy bash session-start.sh. Two responsibilities:
 *   1. Run the baseline scanner (cache-hit budget ~2s) and inject the result
 *      as additionalContext so the agent sees a cheap project orientation.
 *   2. Print the once-per-day activation notice (preserved from the bash
 *      script) on stderr so it lands in Claude Code's transcript.
 *
 * Hook contract (SessionStart):
 *   stdout → { hookSpecificOutput: { hookEventName: "SessionStart",
 *                                    additionalContext?: string } }
 *
 * Per Claude Code's hook docs, the `additionalContext` field for SessionStart
 * is appended to the system prompt for the new session, so the baseline lands
 * in the agent's visible context window automatically.
 *
 * Design rules:
 *   - Never throw — pass-through on any error.
 *   - 2-second budget: if scan blows the budget we still emit *something*
 *     (an empty additionalContext) rather than hang the session.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { spawnSync } from "child_process";

import { formatBaseline, scan } from "../scripts/baseline-scan";

export const ACTIVATION_NOTICE =
  "ashlr-plugin v0.6.0 active — 9 MCP tools incl. summarization. /ashlr:ashlr-doctor to verify, /ashlr-savings for totals.";
export const SCAN_BUDGET_MS = 2000;

/**
 * Ensure the plugin's dependencies are installed.
 * Claude Code clones the plugin but does not run `bun install`, so on first
 * session we detect the missing node_modules and bootstrap them silently.
 * Idempotent: no-op when deps are already present.
 *
 * Runs in the background so the SessionStart hook never blocks the agent.
 */
const SEMVER_DIR_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Remove sibling versioned cache directories for the ashlr plugin so only the
 * current active version remains. This prevents ~/.claude/plugins/cache from
 * growing unboundedly across plugin upgrades.
 *
 * Safety guards:
 *   - Only acts when `${CLAUDE_PLUGIN_ROOT}` is set and its parent basename
 *     matches strict semver (`X.Y.Z`). If the shape looks unexpected we do
 *     nothing — never risk wiping user data.
 *   - Only removes siblings whose basename also matches strict semver; any
 *     other directory (e.g. `latest`, dotfiles, non-semver tags) is left
 *     untouched.
 *   - Wrapped in try/catch — never throws from inside a hook.
 *
 * Emits one stderr line when anything was removed.
 */
export function cleanupStalePluginVersions(
  pluginRoot: string | undefined = process.env.CLAUDE_PLUGIN_ROOT,
  opts: { logger?: (msg: string) => void } = {},
): { removed: string[]; reason?: string } {
  const log = opts.logger ?? ((m: string) => process.stderr.write(m));
  try {
    if (!pluginRoot) return { removed: [], reason: "no-plugin-root" };
    const currentVersion = basename(pluginRoot.replace(/\/+$/, ""));
    if (!SEMVER_DIR_RE.test(currentVersion)) {
      return { removed: [], reason: "unexpected-shape" };
    }
    const parent = dirname(pluginRoot.replace(/\/+$/, ""));
    if (!existsSync(parent)) return { removed: [], reason: "no-parent" };

    const entries = readdirSync(parent, { withFileTypes: true });
    const removed: string[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === currentVersion) continue;
      if (!SEMVER_DIR_RE.test(ent.name)) continue;
      const target = join(parent, ent.name);
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(ent.name);
      } catch {
        /* ignore per-directory errors */
      }
    }
    if (removed.length > 0) {
      log(`[ashlr] cleaned ${removed.length} stale cache version(s): ${removed.join(", ")}\n`);
    }
    return { removed };
  } catch {
    return { removed: [], reason: "error" };
  }
}

export function ensureDepsInstalled(pluginRoot?: string): void {
  const root = pluginRoot ?? (process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, ".."));
  if (existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"))) return;
  // Fire-and-forget: we don't want to block the hook, but we do want to report.
  try {
    const res = spawnSync("bun", ["install"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
      env: { ...process.env, CI: "1" },
    });
    if (res.status === 0) {
      process.stderr.write("[ashlr] first-run: dependencies installed.\n");
    } else {
      process.stderr.write(
        "[ashlr] dependencies missing and auto-install failed. Run manually: " +
          `cd "${root}" && bun install\n`,
      );
    }
  } catch {
    process.stderr.write(
      `[ashlr] dependencies missing. Run: cd "${root}" && bun install\n`,
    );
  }
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext?: string;
  };
}

export function announceStampPath(home: string = homedir()): string {
  return join(home, ".ashlr", "last-announce");
}

/** Returns the activation notice if it hasn't fired today, else null. */
export function maybeActivationNotice(
  home: string = homedir(),
  today: string = new Date().toISOString().slice(0, 10),
): string | null {
  const stamp = announceStampPath(home);
  let last = "";
  try {
    if (existsSync(stamp)) last = readFileSync(stamp, "utf-8").trim();
  } catch {
    /* ignore */
  }
  if (last === today) return null;
  try {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, today);
  } catch {
    /* ignore */
  }
  return ACTIVATION_NOTICE;
}

export interface BuildOpts {
  dir?: string;
  home?: string;
  today?: string;
  budgetMs?: number;
  /** Override the scanner — used in tests. */
  scanFn?: typeof scan;
  formatFn?: typeof formatBaseline;
}

export interface BuildResult {
  output: HookOutput;
  notice: string | null;
}

export function buildResponse(opts: BuildOpts = {}): BuildResult {
  const home = opts.home ?? homedir();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const doScan = opts.scanFn ?? scan;
  const doFormat = opts.formatFn ?? formatBaseline;

  let baselineBlock = "";
  try {
    const b = doScan({ dir: opts.dir });
    baselineBlock = doFormat(b);
  } catch {
    baselineBlock = "[ashlr baseline · unavailable]";
  }

  const notice = maybeActivationNotice(home, today);

  const additionalContext = baselineBlock;

  return {
    output: {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    },
    notice,
  };
}

async function main(): Promise<void> {
  // First-run: bootstrap dependencies if missing. Silent no-op otherwise.
  ensureDepsInstalled();

  // Post-upgrade hygiene: drop sibling cache versions that aren't the active
  // one. Never throws (see cleanupStalePluginVersions for safety guards).
  cleanupStalePluginVersions();

  // Drain stdin (Claude Code passes hook input as JSON) but we don't need it.
  try {
    // Best-effort, non-blocking-ish: only attempt if stdin is a pipe.
    if (!process.stdin.isTTY) {
      // Read but don't wait forever
      await Promise.race([
        (async () => {
          for await (const _ of process.stdin as AsyncIterable<unknown>) {
            // discard
          }
        })(),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }
  } catch {
    /* ignore */
  }

  let result: BuildResult;
  try {
    result = await Promise.race([
      Promise.resolve(buildResponse()),
      new Promise<BuildResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              output: {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: "[ashlr baseline · timed out]",
                },
              },
              notice: null,
            }),
          SCAN_BUDGET_MS,
        )
      ),
    ]);
  } catch {
    result = {
      output: { hookSpecificOutput: { hookEventName: "SessionStart" } },
      notice: null,
    };
  }

  if (result.notice) {
    // stderr so it surfaces in the Claude Code transcript without polluting
    // the JSON hook response on stdout.
    process.stderr.write(result.notice + "\n");
  }
  process.stdout.write(JSON.stringify(result.output));
}

if (import.meta.main) {
  await main();
}
