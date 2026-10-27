/** Session identity resolution shared by stats readers and writers. */
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Derive the PPID-based fallback session id. Used when CLAUDE_SESSION_ID is
 * not forwarded to this process (which, as of v0.9.x, is what happens for
 * MCP server subprocesses Claude Code spawns - it passes the env var to the
 * status-line and hooks, but NOT to MCP servers).
 */
function ppidSessionId(): string {
  const seed = `ppid:${typeof process.ppid === "number" ? process.ppid : "?"}:${process.env.HOME ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(16)}`;
}

/**
 * v1.19.2: read a sessionId hint from ~/.ashlr/last-project.json (written by
 * hooks/session-start.ts in hook-context where CLAUDE_SESSION_ID IS set).
 * Used when the running process doesn't see the env var (MCP subprocesses,
 * status-line). Hint is gated on a 24h updatedAt TTL so stale entries from
 * old sessions don't leak into new ones.
 *
 * v1.20.2: exported + accepts an optional homeDir so callers in other
 * processes (status-line, sqlite stats backend) can share the same logic
 * instead of duplicating it. The single-source-of-truth prevents the
 * recurring "session counter stuck at 0" regressions (v0.9.3, v1.0.1,
 * v1.20.1) caused by drifted local copies.
 */
export const SESSION_HINT_TTL_MS = 24 * 60 * 60 * 1000;

export function readSessionHint(homeDir: string = process.env.HOME ?? ""): string | null {
  if (!homeDir) return null;
  try {
    const hintPath = join(homeDir, ".ashlr", "last-project.json");
    const raw = readFileSync(hintPath, "utf-8");
    const parsed = JSON.parse(raw) as { sessionId?: unknown; updatedAt?: unknown };
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim().length === 0) return null;
    if (typeof parsed.updatedAt !== "string") return null;
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > SESSION_HINT_TTL_MS) return null;
    return parsed.sessionId.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the current session id for WRITERS. Prefers CLAUDE_SESSION_ID
 * (set by Claude Code for status-line/hook contexts); falls back to the
 * session-start hint file (v1.19.2 - captured where CLAUDE_SESSION_ID is
 * visible); falls back to PPID-derived hash as a last resort.
 *
 * NEVER returns an empty string - always a stable identifier.
 */
export function currentSessionId(): string {
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const hint = readSessionHint();
  if (hint) return hint;
  return ppidSessionId();
}

/**
 * Resolve the set of session ids this process could belong to, for READERS.
 * Because Claude Code inconsistently forwards CLAUDE_SESSION_ID (status line
 * sees it, MCP servers don't), a reader that used only `currentSessionId()`
 * would miss savings written under the OTHER id.
 *
 * v1.19.2: also include the session-start hint id so writers and readers
 * converge on a shared bucket even when neither side sees the env var.
 *
 * The status line calls this and sums across every candidate bucket so the
 * session counter stays correct regardless of which side CLAUDE_SESSION_ID
 * reached.
 */
export function candidateSessionIds(): string[] {
  const ids: string[] = [];
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) ids.push(explicit.trim());
  const hint = readSessionHint();
  if (hint && !ids.includes(hint)) ids.push(hint);
  const ppid = ppidSessionId();
  if (!ids.includes(ppid)) ids.push(ppid);
  return ids;
}

