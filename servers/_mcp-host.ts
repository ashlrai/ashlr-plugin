/**
 * Multi-host MCP detection.
 *
 * The ashlr MCP server is consumable from any MCP-capable host (Claude Code,
 * Cline, Claude Desktop, OpenAI Codex CLI, …). Most behavior is host-agnostic:
 *  - tool dispatch, snipCompact, genome retrieval, stats accounting all work
 *    regardless of who's calling.
 *  - PPID-derived session id (see `_stats.ts::ppidSessionId`) covers any host
 *    that doesn't forward `CLAUDE_SESSION_ID`.
 *  - `existsSync` guards on `~/.claude/` paths mean missing-CC-dirs are a
 *    no-op rather than a crash.
 *
 * But a few code paths are Claude-Code-specific (hook firing, status-line
 * rendering, OAuth-token harvest from `~/.claude/.credentials.json`). The
 * `ASHLR_MCP_HOST` env var declares which host launched us so those code
 * paths can short-circuit cleanly when running under a non-CC host.
 *
 * Each host's MCP server config sets the env var:
 *
 *   Claude Code  (default, no change needed)  → undefined or "claude-code"
 *   Cline (cline_mcp_settings.json)           → "cline"
 *   Claude Desktop (claude_desktop_config.json) → "claude-desktop"
 *   Codex CLI (~/.codex/config.toml)          → "codex-cli"
 *   Anything else                              → "generic"
 *
 * Backwards compat: when unset, we infer "claude-code" so existing installs
 * keep their exact current behavior. The audit covered every gate; none of
 * them change behavior when the env var is absent.
 */

export type McpHost =
  | "claude-code"
  | "cline"
  | "claude-desktop"
  | "codex-cli"
  | "generic";

const KNOWN_HOSTS: ReadonlySet<McpHost> = new Set([
  "claude-code",
  "cline",
  "claude-desktop",
  "codex-cli",
  "generic",
]);

/**
 * Resolve which MCP host launched this process.
 *
 * Precedence:
 *   1. `ASHLR_MCP_HOST` env var (explicit, set by each host's config snippet).
 *   2. Presence of `CLAUDE_SESSION_ID` or `CLAUDE_PLUGIN_ROOT` → "claude-code"
 *      (covers the default Claude Code install path so users who don't set
 *      the env var still see the original behavior).
 *   3. Fallback "generic" — safe default; disables CC-only side effects.
 *
 * Never throws; never reads files; never logs. Cheap to call repeatedly.
 */
export function detectMcpHost(env: NodeJS.ProcessEnv = process.env): McpHost {
  const explicit = env.ASHLR_MCP_HOST?.trim().toLowerCase();
  if (explicit && KNOWN_HOSTS.has(explicit as McpHost)) {
    return explicit as McpHost;
  }
  // Inference: any of these signals → Claude Code (preserves existing
  // behavior for users who haven't set ASHLR_MCP_HOST).
  if (
    (env.CLAUDE_SESSION_ID && env.CLAUDE_SESSION_ID.trim().length > 0) ||
    (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim().length > 0) ||
    (env.CLAUDE_CODE_MODEL && env.CLAUDE_CODE_MODEL.trim().length > 0)
  ) {
    return "claude-code";
  }
  // Generic is the safe non-CC default: hooks/status-line code paths
  // short-circuit; stats + genome + dispatch still work normally.
  return "generic";
}

/** Convenience: are we running inside Claude Code (the default host)? */
export function isClaudeCodeHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectMcpHost(env) === "claude-code";
}

/**
 * Convenience: should we skip Claude-Code-specific side effects?
 * Returns true for every non-CC host. Used by:
 *  - status-line install nudges (other hosts have their own UI)
 *  - `~/.claude/settings.json` writes (other hosts use their own config)
 *  - hook-firing assumptions (only CC fires PreToolUse/SessionEnd hooks)
 */
export function skipClaudeCodeSideEffects(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return detectMcpHost(env) !== "claude-code";
}
