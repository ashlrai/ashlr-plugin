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
 *
 * Only (1) is automatic; (2) and (3) are trust anchors the user or the host
 * application has explicitly provided. A prompt-injected attacker can't
 * inject new env vars, so the allow-list stays under user control.
 *
 * `path.relative()` is the right primitive because `startsWith(cwd + sep)`
 * breaks on Windows drive roots (`C:\` already ends with a separator, and
 * a cross-drive path resolves to an absolute path, not one starting with
 * `..`).
 */

import { realpathSync } from "fs";
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
 * Collect the canonicalized allow-list of root paths the clamp accepts.
 * Always includes `process.cwd()`; optionally extends with
 * `CLAUDE_PROJECT_DIR` (from Claude Code) and `ASHLR_ALLOW_PROJECT_PATHS`
 * (user opt-in). Deduped so refusal messages stay readable.
 */
function allowedRoots(): string[] {
  const roots: string[] = [canonical(process.cwd())];

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
