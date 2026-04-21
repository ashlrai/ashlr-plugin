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
import { greet as sessionGreet } from "../scripts/session-greet";
import { initSessionBucket } from "../servers/_stats";
import { isFirstRun, writeStamp, stampPath } from "../scripts/onboarding-wizard";
import { checkForUpdate } from "../scripts/auto-update";
import { runCloudPull } from "../scripts/genome-cloud-pull";

export const ACTIVATION_NOTICE =
  "ashlr-plugin v1.9.0 active — Windows/macOS/Linux · 27 skills · /ashlr-start for the onboarding wizard · /ashlr-upgrade to go Pro from the terminal.";
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
    // Only sweep inside Claude Code's plugin cache tree. Guards against a
    // stray CLAUDE_PLUGIN_ROOT pointing at e.g. ~/.nvm/versions/node/1.0.0
    // which would otherwise make us rm semver-shaped siblings.
    if (!parent.includes("/plugins/cache/")) {
      return { removed: [], reason: "parent-not-in-plugin-cache" };
    }

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

/** Path to the first-run stamp file. Re-exported for tests. */
export { stampPath, isFirstRun, writeStamp } from "../scripts/onboarding-wizard";

/**
 * Returns the additionalContext string that fires the onboarding wizard on
 * first run, or null when the stamp already exists.
 *
 * Side effect: writes the stamp on first run so subsequent sessions skip it.
 */
export function maybeWizardTrigger(home: string = homedir()): string | null {
  if (!isFirstRun(home)) return null;
  writeStamp(home);
  return (
    "\n[ashlr] This is your first session with the ashlr-plugin. " +
    "Please run /ashlr-start now to complete the 60-second onboarding wizard. " +
    "It will check your setup, offer to approve tool permissions, show a live " +
    "read demo, and optionally initialize a genome for this project.\n"
  );
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
  const wizardTrigger = maybeWizardTrigger(home);

  const additionalContext = wizardTrigger
    ? baselineBlock + wizardTrigger
    : baselineBlock;

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

/**
 * Source ~/.ashlr/env if it exists, injecting KEY=VALUE lines into
 * process.env. This makes ASHLR_PRO_TOKEN (and any other vars written by
 * upgrade-flow.ts) available to all subsequent hook logic and sub-processes
 * in this session — without requiring a shell restart.
 */
function sourceAshlrEnv(): void {
  try {
    const envFile = join(homedir(), ".ashlr", "env");
    if (!existsSync(envFile)) return;
    const content = readFileSync(envFile, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Match: export KEY=VALUE  or  KEY=VALUE  (value may be quoted or bare)
      const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!;
      // Strip surrounding single or double quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        // Only set if not already present — never override explicit env vars
        process.env[key] = val;
      }
    }
  } catch {
    /* env file is decoration — never break the hook */
  }
}

async function main(): Promise<void> {
  // Source ~/.ashlr/env so ASHLR_PRO_TOKEN from the upgrade flow is available
  // without requiring a shell restart.
  sourceAshlrEnv();

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

  // Initialize the per-session bucket in ~/.ashlr/stats.json. This sets
  // `startedAt` for the current CLAUDE_SESSION_ID so `/ashlr-savings` can
  // report "session started Nm ago" accurately. Fire-and-forget — a stats
  // write never blocks the hook response.
  try { await initSessionBucket(); } catch { /* stats is decoration */ }

  // Run the session-start greeting (first-run welcome / normal 1-liner /
  // weekly digest). Writes to stderr; swallows its own errors. We run this
  // AFTER the legacy notice so the greeting is the last thing the user sees
  // in the transcript.
  try {
    sessionGreet();
  } catch {
    /* greeting is decoration — never break the hook */
  }

  // Fire-and-forget update check. Reads plugin.json for the current version,
  // fetches the latest GitHub release (2s timeout), and prints a one-line
  // notice to stderr at most once per day per upstream version.
  try {
    const pluginJsonPath = new URL("../.claude-plugin/plugin.json", import.meta.url).pathname;
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8")) as { version?: string };
    const currentVersion = pluginJson.version ?? "";
    // Intentionally not awaited — fire-and-forget so it never delays the hook.
    void checkForUpdate({ currentVersion });
  } catch {
    /* update check is decoration — never break the hook */
  }

  // Best-effort cloud genome pull. No-ops silently when: kill switch set,
  // no pro-token, not a git repo, or genome not yet ready. Never blocks.
  try { await runCloudPull(); } catch { /* cloud pull is decoration — never break the hook */ }

  process.stdout.write(JSON.stringify(result.output));
}

if (import.meta.main) {
  await main();
}
