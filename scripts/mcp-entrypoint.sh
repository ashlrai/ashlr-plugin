#!/usr/bin/env bash
# ashlr-plugin MCP server entrypoint.
#
# Wraps every MCP server launch with idempotent self-healing:
#   1. cd to the plugin root
#   2. if node_modules is missing, run `bun install` (once; subsequent launches skip)
#   3. opportunistically drop stale sibling versioned cache dirs (best-effort)
#   4. exec `bun run <server.ts>` with any passed args
#
# Why this exists: Claude Code's /plugin install clones the plugin to a new
# versioned cache dir but doesn't run bun install. The SessionStart hook can
# auto-install, but only on a fresh session — not on /reload-plugins. Wrapping
# every server launch here closes that gap: the first server to start after a
# fresh install will block briefly to install deps, then exec normally.
#
# Usage (in .claude-plugin/plugin.json mcpServers entries):
#   "command": "bash",
#   "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-entrypoint.sh", "servers/foo-server.ts"]
#
# All output is suppressed to stdout (since stdio is the MCP protocol channel).
# Logs go to stderr, which Claude Code surfaces in its transcript.

set -e

# Resolve plugin root from the entrypoint's own path (never trust cwd).
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PLUGIN_ROOT"

# 1. Self-install deps if missing. Idempotent.
if [ ! -d "node_modules/@modelcontextprotocol/sdk" ]; then
  echo "[ashlr] first-run: installing dependencies in $PLUGIN_ROOT" >&2
  if ! bun install --silent >&2 2>&1; then
    echo "[ashlr] bun install failed. Ensure bun is on PATH and network is available." >&2
    echo "[ashlr] Manual fix: cd \"$PLUGIN_ROOT\" && bun install" >&2
    exit 1
  fi
fi

# 2. Opportunistically drop stale sibling version caches. Safe: strict semver
#    guard + skip current dir. Non-version dirs (latest, dev-branch) survive.
CURRENT_VERSION="$(basename "$PLUGIN_ROOT")"
PARENT="$(dirname "$PLUGIN_ROOT")"
if [[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -d "$PARENT" ]; then
  for sib in "$PARENT"/*/; do
    sib="${sib%/}"
    name="$(basename "$sib")"
    if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$name" != "$CURRENT_VERSION" ]; then
      rm -rf "$sib" 2>/dev/null && echo "[ashlr] removed stale cache: $name" >&2 || true
    fi
  done
fi

# 3. Exec the requested server script with any remaining args.
exec bun run "$@"
