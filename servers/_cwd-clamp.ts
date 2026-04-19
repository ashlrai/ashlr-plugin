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
 * This helper clamps a caller-supplied path to `process.cwd()` and its
 * descendants. It's the same check that shipped inlined in `ls-server.ts`
 * for v1.11.1; v1.11.2 propagates it to glob, tree, and grep.
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
    const parts = p.split(sep);
    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = parts.slice(0, i).join(sep) || sep;
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
 * Resolve `userPath` against cwd and verify it stays inside cwd.
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
  const cwd = canonical(process.cwd());
  const rootAbs = canonical(resolve(userPath ?? "."));
  const rel = relative(cwd, rootAbs);
  const insideCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!insideCwd) {
    return {
      ok: false,
      message: `${toolName}: refused path outside working directory: ${rootAbs}\n(cwd is ${cwd})`,
    };
  }
  return { ok: true, abs: rootAbs };
}
