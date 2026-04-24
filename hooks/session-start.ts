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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { spawnSync } from "child_process";

import { formatBaseline, scan } from "../scripts/baseline-scan";
import { greet as sessionGreet } from "../scripts/session-greet";
import { initSessionBucket } from "../servers/_stats";
import { isFirstRun, writeStamp, stampPath } from "../scripts/onboarding-wizard";
import { checkForUpdate } from "../scripts/auto-update";
import { runCloudPull } from "../scripts/genome-cloud-pull";

/**
 * Template for the once-per-day activation notice. Placeholders are filled
 * in at runtime by `buildActivationNotice()` so the version + skill count
 * can never drift from the actual installed plugin (v1.17 had this wrong
 * because the values were hardcoded).
 */
export const ACTIVATION_NOTICE_TEMPLATE =
  "ashlr-plugin v{version} active — Windows/macOS/Linux · {toolCount} skills · /ashlr-start for the onboarding wizard · /ashlr-upgrade to go Pro from the terminal.";

/**
 * Default plugin root — resolves to this hook's parent directory when
 * CLAUDE_PLUGIN_ROOT isn't set (e.g. during tests that import buildResponse
 * directly).
 */
function defaultPluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, "..");
}

/**
 * Read the plugin's current version from .claude-plugin/plugin.json. Returns
 * a fallback of "unknown" if anything goes wrong — the banner is decoration,
 * it must never throw.
 */
export function readPluginVersion(pluginRoot: string = defaultPluginRoot()): string {
  try {
    const pj = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8"),
    ) as { version?: unknown };
    if (typeof pj.version === "string" && pj.version.trim()) return pj.version.trim();
  } catch {
    /* ignore */
  }
  return "unknown";
}

/**
 * Count the number of user-facing skills shipped by the plugin. Each slash
 * command (e.g. /ashlr-start) is one `.md` file under commands/, so we count
 * those rather than the MCP tool list (which targets the model, not the user).
 */
export function readToolCount(pluginRoot: string = defaultPluginRoot()): number {
  try {
    const dir = join(pluginRoot, "commands");
    if (!existsSync(dir)) return 0;
    const st = statSync(dir);
    if (!st.isDirectory()) return 0;
    return readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** Render the activation notice with runtime-resolved version + tool count. */
export function buildActivationNotice(
  pluginRoot: string = defaultPluginRoot(),
): string {
  const version = readPluginVersion(pluginRoot);
  const toolCount = readToolCount(pluginRoot);
  return ACTIVATION_NOTICE_TEMPLATE.replace("{version}", version).replace(
    "{toolCount}",
    String(toolCount),
  );
}

/**
 * Back-compat shim: downstream tests/scripts import ACTIVATION_NOTICE as a
 * bare string. We resolve it lazily at module load via the helpers above so
 * the value is always in sync with plugin.json + the commands/ dir.
 */
export const ACTIVATION_NOTICE = buildActivationNotice();
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
    // basename/dirname handle trailing separators on both POSIX and Windows,
    // so the old `.replace(/\/+$/, "")` was a no-op on Windows (only stripped
    // forward slashes) and redundant on POSIX.
    const currentVersion = basename(pluginRoot);
    if (!SEMVER_DIR_RE.test(currentVersion)) {
      return { removed: [], reason: "unexpected-shape" };
    }
    const parent = dirname(pluginRoot);
    if (!existsSync(parent)) return { removed: [], reason: "no-parent" };
    // Only sweep inside Claude Code's plugin cache tree. Guards against a
    // stray CLAUDE_PLUGIN_ROOT pointing at e.g. ~/.nvm/versions/node/1.0.0
    // which would otherwise make us rm semver-shaped siblings. Normalize
    // separators so the check works on Windows (\plugins\cache\) too.
    if (!parent.replace(/\\/g, "/").includes("/plugins/cache/")) {
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

/**
 * Path to `~/.ashlr/last-project.json` — a small hint file the MCP servers
 * read to discover the user's real project directory.
 *
 * Why this file exists (v1.19.1 hotfix): Claude Code forwards
 * `CLAUDE_PROJECT_DIR` to *hooks* but NOT to MCP subprocesses. Without this
 * hint, the filesystem-touching MCP tools (ashlr__read, ashlr__grep, etc.)
 * refuse any path outside their launch cwd — which is the plugin install
 * dir under `.claude/plugins/cache/`, not the user's project. The redirect
 * hook tells the model to call `ashlr__read` with an absolute project path,
 * so without the hint the two halves dead-end each other. The session-start
 * hook (which *does* see `CLAUDE_PROJECT_DIR`) writes this file so the MCP
 * clamp can include the project dir in its allow-list.
 */
/**
 * v1.19.2: stable session-id fallback when CLAUDE_SESSION_ID isn't visible.
 * Uses process.ppid + home + a per-session random seed persisted to the
 * hint file. Since this runs in SessionStart exactly once per session,
 * the random component changes per session even when ppid recycles — which
 * is what makes it session-unique across Claude Code restarts.
 */
function derivedSessionId(_home: string): string {
  const seed = `h:${process.ppid ?? "?"}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

export function projectHintPath(home: string = homedir()): string {
  return join(home, ".ashlr", "last-project.json");
}

/**
 * Write the last-project hint. Picks up the project dir from
 * `CLAUDE_PROJECT_DIR` (set by Claude Code in hook environments); no-ops
 * silently when unset, when the dir doesn't exist, or on any write error —
 * the hint is decoration, not a contract.
 *
 * Shape:
 *   { "projectDir": "/absolute/path", "updatedAt": "2026-...", "sessionId": "..." }
 *
 * The `sessionId` hint lets future MCP tooling detect cross-session staleness
 * cheaply (hook ran in session X, MCP spawned in session Y → possibly stale).
 * The MCP clamp today uses a 24h TTL on `updatedAt` and ignores `sessionId`.
 */
export function writeProjectHint(
  opts: {
    home?: string;
    projectDir?: string;
    sessionId?: string;
    now?: Date;
  } = {},
): { ok: boolean; reason?: string; path?: string } {
  try {
    const home = opts.home ?? (process.env.ASHLR_HOME_OVERRIDE?.trim() || homedir());
    const projectDir = opts.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? "";
    if (!projectDir) return { ok: false, reason: "no-project-dir" };
    // Only write when the path actually exists and is a directory — guards
    // against a stale env or a race where the project was deleted mid-session.
    try {
      const st = statSync(projectDir);
      if (!st.isDirectory()) return { ok: false, reason: "not-a-directory" };
    } catch {
      return { ok: false, reason: "stat-failed" };
    }
    // v1.19.2: sessionId is ALWAYS written. Priority: explicit opt → env
    // (CLAUDE_SESSION_ID, ASHLR_SESSION_ID) → stable PPID-hash derived at
    // session start. The deterministic fallback guarantees MCP + status-line
    // readers converge on the SAME bucket even when neither sees the env.
    const explicitSession =
      opts.sessionId ??
      process.env.CLAUDE_SESSION_ID ??
      process.env.ASHLR_SESSION_ID;
    const sessionId =
      explicitSession && explicitSession.trim().length > 0
        ? explicitSession.trim()
        : derivedSessionId(home);
    const payload: Record<string, string> = {
      projectDir,
      updatedAt: (opts.now ?? new Date()).toISOString(),
      sessionId,
    };
    const path = projectHintPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2));
    return { ok: true, path };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "write-failed" };
  }
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
  // Resolve the notice lazily so version + skill count reflect the plugin
  // currently on disk — never a stale copy captured at module-load time.
  return buildActivationNotice();
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

  // v1.19.1 hotfix: Claude Code forwards CLAUDE_PROJECT_DIR to hooks but
  // NOT to MCP subprocesses. Write the project dir to ~/.ashlr/last-project.json
  // so filesystem-touching MCP tools (ashlr__read, ashlr__grep, etc.) can
  // extend their cwd-clamp allow-list to the user's real workspace. Without
  // this, the PreToolUse redirect hook sends the model to ashlr__read with
  // an absolute project path that the clamp then refuses — a dead-end loop.
  try { writeProjectHint(); } catch { /* hint is decoration — never break the hook */ }

  // Opt-in: when ASHLR_STATS_BACKEND=sqlite, move the legacy ~/.ashlr/stats.json
  // into ~/.ashlr/stats.db once at session start so MCP workers open an
  // already-initialized db and don't race on first-time schema creation.
  // Never throws — stats writes must never block the agent.
  if (process.env.ASHLR_STATS_BACKEND === "sqlite") {
    try {
      const { migrateStatsIfNeeded } = await import("../scripts/migrate-stats-to-sqlite");
      await migrateStatsIfNeeded();
    } catch {
      /* best-effort */
    }
  }

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
