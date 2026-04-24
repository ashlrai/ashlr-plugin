/**
 * Shared cwd clamp for filesystem-touching MCP tools.
 *
 * The MCP tools in this directory run inside the user's Claude Code session
 * with whatever filesystem access the host shell has. The calling model can
 * be prompt-injected by third-party content (file contents, tool output,
 * web pages it's summarizing) — so a tool that accepts an arbitrary `path`
 * or `cwd` argument and then walks the filesystem is a direct disclosure
 * channel: `glob pattern="**" cwd="/etc"` or `tree path="/"` both exfiltrate
 * the host's filesystem layout.
 *
 * This helper clamps a caller-supplied path to an allow-list of roots:
 *   1. `process.cwd()` (the MCP server's launch dir — usually the plugin cache)
 *   2. `$CLAUDE_PROJECT_DIR` if set (Claude Code forwards this in hooks; we
 *      forward it through `scripts/mcp-entrypoint.ts` so MCP tools can touch
 *      the user's actual workspace, not just the plugin cache)
 *   3. Any path in `$ASHLR_ALLOW_PROJECT_PATHS` (colon-separated on Unix,
 *      semicolon on Windows) — explicit user opt-in for plugin developers
 *      and users with multi-root workspaces
 *   4. Fallback: `~/.ashlr/last-project.json::projectDir` — used ONLY when
 *      (2) and (3) are both unset AND process.cwd() looks like the plugin
 *      install dir. This handles the case where Claude Code does NOT forward
 *      CLAUDE_PROJECT_DIR to MCP subprocesses (verified behavior as of
 *      v1.19.0). The session-start hook writes the file with the real project
 *      dir, and the MCP server reads it as a last-resort hint.
 *
 * Only (1) is automatic; (2), (3), and (4) are trust anchors that only appear
 * when the user or the host application has signed off: (2) + (3) via explicit
 * env vars; (4) via a file that the session-start hook writes on behalf of
 * Claude Code itself. A prompt-injected attacker can't inject new env vars or
 * write into `~/.ashlr/` without already owning the host. The stale-file
 * check + canonical() + existence-check below guard against attacker-crafted
 * or old hint files opening new filesystem access.
 *
 * `path.relative()` is the right primitive because `startsWith(cwd + sep)`
 * breaks on Windows drive roots (`C:\` already ends with a separator, and
 * a cross-drive path resolves to an absolute path, not one starting with
 * `..`).
 */

import { readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";

export type ClampResult =
  | { ok: true; abs: string }
  | { ok: false; message: string };

/**
 * Resolve symlinks to a canonical form when possible, fall back to a plain
 * resolve for paths that don't exist yet. macOS returns `process.cwd()` in
 * canonical form (e.g., `/private/var/folders/…`) while user-supplied tmp
 * paths come back as their symlinked shortcut (`/var/folders/…`). Without
 * this canonicalization, the clamp check below would refuse legitimate
 * paths inside cwd on macOS.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist yet — walk up to the nearest existing ancestor,
    // canonicalize that, and reattach the non-existent suffix. Without this
    // walk-up, a path like "/var/tmp/abc/nope" (where /var → /private/var
    // and "nope" doesn't exist) would compare unresolved against a
    // canonicalized cwd and be wrongly refused on macOS.
    //
    // Cap the walk at MAX_WALK_UP segments so a prompt-injected caller can't
    // pass a pathologically long path to force O(n) synchronous realpathSync
    // failures. Real filesystems never nest anywhere near this deep; anything
    // beyond it is either malicious or already outside any plausible cwd.
    const parts = p.split(sep);
    const MAX_WALK_UP = 32;
    const start = parts.length - 1;
    const stop = Math.max(1, start - MAX_WALK_UP);
    for (let i = start; i >= stop; i--) {
      let prefix = parts.slice(0, i).join(sep) || sep;
      // Windows drive-letter-only prefixes ("D:", "C:") are *drive-relative*,
      // not absolute: `realpathSync("D:")` resolves to the per-drive current
      // working directory, not the drive root. Without this guard, a
      // non-existent outside path like "D:\\etc" walks up to "D:", which
      // canonicalizes to cwd, and then the suffix "etc" gets joined back —
      // producing `<cwd>\\etc` and wrongly clamping an outside path *inside*
      // cwd. Normalise to the drive root ("D:\\") so realpathSync returns
      // the root itself instead of the per-drive CWD.
      if (process.platform === "win32" && /^[A-Za-z]:$/.test(prefix)) {
        prefix = prefix + sep;
      }
      try {
        return join(realpathSync(prefix), ...parts.slice(i));
      } catch {
        // Shorter prefix; keep climbing.
      }
    }
    return p;
  }
}

/**
 * Detect whether `process.cwd()` looks like an ashlr plugin install dir,
 * i.e. a Claude Code plugin cache path. Used to gate the `last-project.json`
 * fallback — we only read the file when the MCP server was spawned without
 * a project-dir hint via env.
 *
 * Two signals:
 *   - Path contains `.claude/plugins/cache/` (normalized for Windows).
 *   - `$CLAUDE_PLUGIN_ROOT` is set and equals (canonically) process.cwd().
 */
function cwdLooksLikePluginRoot(cwd: string): boolean {
  const normalized = cwd.replace(/\\/g, "/");
  if (normalized.includes("/.claude/plugins/cache/")) return true;
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  if (pluginRoot) {
    try {
      if (canonical(resolve(pluginRoot)) === cwd) return true;
    } catch {
      // ignore — plugin root may not exist in tests
    }
  }
  return false;
}

/**
 * Staleness check for `last-project.json`. Returns true iff the hint was
 * written in the last 24h. This guards against reviving access to an old
 * project after the user has moved on — a stale hint is effectively an
 * ambient-authority grant we want to decay.
 */
const LAST_PROJECT_TTL_MS = 24 * 60 * 60 * 1000;
function hintIsFresh(updatedAt: string | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= LAST_PROJECT_TTL_MS;
}

/**
 * Resolve the effective $HOME for the hint file. Respects
 * `ASHLR_HOME_OVERRIDE` as a test-only escape hatch (Bun caches `homedir()`
 * at startup and does not re-read `HOME` on mutation, so tests can't rely
 * on `process.env.HOME =` the way Node does). In production this env var
 * is unset and we fall back to `homedir()`.
 */
function resolveHintHome(): string {
  const override = process.env["ASHLR_HOME_OVERRIDE"];
  if (override && override.trim()) return override.trim();
  return homedir();
}

/**
 * Read the `~/.ashlr/last-project.json` hint file (if present + fresh) and
 * return its canonicalised `projectDir`. Returns null when:
 *   - file missing / unreadable / invalid JSON
 *   - `updatedAt` older than 24h
 *   - `projectDir` missing, not a string, or does not resolve to an existing
 *     directory (stale entries from a deleted workspace are ignored)
 *
 * The canonical() + existsSync-via-statSync gauntlet ensures an attacker who
 * can write into `~/.ashlr/last-project.json` can't grant access to
 * non-existent paths — but note: if they can write `~/.ashlr/`, they already
 * own the host. The check is defense-in-depth, not a security boundary.
 *
 * Exported with the `_...ForTest` prefix to signal it is for the companion
 * cwd-clamp tests only; `allowedRoots()` below is the production caller.
 */
export function _readLastProjectHintForTest(home: string = resolveHintHome()): string | null {
  try {
    const p = join(home, ".ashlr", "last-project.json");
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as {
      projectDir?: unknown;
      updatedAt?: unknown;
    };
    if (typeof parsed.projectDir !== "string" || !parsed.projectDir) return null;
    if (typeof parsed.updatedAt !== "string" || !hintIsFresh(parsed.updatedAt)) {
      return null;
    }
    const abs = canonical(resolve(parsed.projectDir));
    // Directory must currently exist — a hint pointing at a deleted
    // workspace must not extend the allow-list.
    const st = statSync(abs);
    if (!st.isDirectory()) return null;
    return abs;
  } catch {
    return null;
  }
}

/**
 * Collect the canonicalized allow-list of root paths the clamp accepts.
 * Always includes `process.cwd()`; optionally extends with
 * `CLAUDE_PROJECT_DIR` (from Claude Code) and `ASHLR_ALLOW_PROJECT_PATHS`
 * (user opt-in). When neither is set *and* the MCP server was spawned from
 * the plugin install dir, falls back to reading a project-dir hint written
 * by the session-start hook. Deduped so refusal messages stay readable.
 */
function allowedRoots(): string[] {
  const cwdAbs = canonical(process.cwd());
  const roots: string[] = [cwdAbs];

  // User-owned config dirs (~/.claude, ~/.ashlr): always allowed. The agent
  // routinely needs to touch ~/.claude/plans, ~/.claude/CLAUDE.md, and
  // ~/.ashlr/{settings,config}.json during normal work — refusing those paths
  // sends every such call back to the built-in Edit/Read fallback and forfeits
  // the per-call savings (12+ refusals/day measured in v1.20.1). Both dirs are
  // gated by host-level filesystem permissions; a prompt-injected attacker
  // who could already read/write the user's project can already reach them
  // via shell, so adding them to the allow-list does not widen the threat
  // surface meaningfully.
  for (const sub of [".claude", ".ashlr"]) {
    try {
      const abs = canonical(resolve(homedir(), sub));
      if (!roots.includes(abs)) roots.push(abs);
    } catch {
      // Home dir missing or sub-dir doesn't exist — skip silently.
    }
  }

  const claudeProjectDir = process.env["CLAUDE_PROJECT_DIR"];
  if (claudeProjectDir) {
    try {
      const abs = canonical(resolve(claudeProjectDir));
      if (!roots.includes(abs)) roots.push(abs);
    } catch {
      // Env var pointed at a path we can't stat — ignore silently. The
      // clamp falls back to the other roots. Logging would spam stderr on
      // every tool call in a workspace with a misspelled env.
    }
  }

  const envPaths = process.env["ASHLR_ALLOW_PROJECT_PATHS"];
  if (envPaths) {
    // Platform-appropriate PATH separator. Users setting this in a
    // cross-platform shell are most likely to use ":" on Unix and ";" on
    // Windows — match Node's `path.delimiter` convention.
    const delim = process.platform === "win32" ? ";" : ":";
    for (const raw of envPaths.split(delim)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const abs = canonical(resolve(trimmed));
        if (!roots.includes(abs)) roots.push(abs);
      } catch {
        // Invalid path entry — skip and keep going.
      }
    }
  }

  // File-based fallback (v1.19.1 hotfix): when *neither* env var is set AND
  // process.cwd() looks like the plugin install dir, read the last-project
  // hint written by the session-start hook. Claude Code does NOT forward
  // CLAUDE_PROJECT_DIR to MCP subprocesses, so without this fallback the
  // MCP server can only see files under the plugin cache.
  //
  // Env wins: if either env var is set, we trust that signal and skip the
  // file entirely (preserves pre-v1.19.1 semantics + keeps tests
  // deterministic when callers explicitly scope the allow-list via env).
  if (!claudeProjectDir && !envPaths && cwdLooksLikePluginRoot(cwdAbs)) {
    const hint = _readLastProjectHintForTest();
    if (hint && !roots.includes(hint)) roots.push(hint);
  }

  return roots;
}

/**
 * Resolve `userPath` against the allow-listed roots and verify it stays
 * inside at least one of them.
 *
 * Returns `{ ok: true, abs }` on success — caller uses `abs` as the
 * filesystem target. Returns `{ ok: false, message }` on refusal — caller
 * should surface `message` verbatim to the model (matches the ls-server
 * convention so agents learn one refusal shape).
 */
export function clampToCwd(
  userPath: string | undefined,
  toolName: string,
): ClampResult {
  const roots = allowedRoots();
  const rootAbs = canonical(resolve(userPath ?? "."));

  for (const root of roots) {
    const rel = relative(root, rootAbs);
    const insideRoot = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (insideRoot) return { ok: true, abs: rootAbs };
  }

  const primary = roots[0];
  const extra = roots.length > 1 ? `; also allowed: ${roots.slice(1).join(", ")}` : "";
  return {
    ok: false,
    message: `${toolName}: refused path outside working directory: ${rootAbs}\n(cwd is ${primary}${extra})`,
  };
}
