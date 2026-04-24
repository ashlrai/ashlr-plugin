#!/usr/bin/env bash
# ashlr-plugin MCP server entrypoint (LEGACY — Unix-only ports).
#
# NOTE: Claude Code itself no longer uses this script. As of v1.15 the
# canonical entrypoint is `scripts/bootstrap.mjs`, which hands off to
# `scripts/mcp-entrypoint.ts`. Both run on Windows without Git Bash.
#
# This `.sh` is retained ONLY for the Unix-only `ports/` distributions
# (Cursor, Goose — see `ports/cursor/mcp.json` and `ports/README.md`).
# If you are on Windows and something invoked this file, that is a bug:
# your plugin config should point at `scripts/bootstrap.mjs` instead.
#
# Wraps every MCP server launch with idempotent self-healing:
#   1. cd to the plugin root
#   2. if node_modules is missing, run `bun install` (once; subsequent launches skip)
#   3. opportunistically drop stale sibling versioned cache dirs (best-effort)
#   4. exec `bun run <server.ts>` with any passed args
#
# Usage (ports distributions only):
#   "command": "bash",
#   "args": ["${ASHLR_PLUGIN_ROOT}/scripts/mcp-entrypoint.sh", "servers/foo-server.ts"]
#
# All output is suppressed to stdout (since stdio is the MCP protocol channel).
# Logs go to stderr, which Claude Code surfaces in its transcript.

# Hard guard: if somehow invoked on Windows, redirect the caller to the
# bun/node-native entrypoint. MSYS/MINGW/CYGWIN all set OSTYPE accordingly.
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*)
    echo "[ashlr] mcp-entrypoint.sh is Unix-only." >&2
    echo "[ashlr] On Windows, point your MCP config at scripts/bootstrap.mjs instead:" >&2
    echo "[ashlr]   node \"\${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs\" servers/<server>.ts" >&2
    exit 1
    ;;
esac

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
if [[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -d "$PARENT" ] && [[ "$PARENT" == */plugins/cache/* ]]; then
  for sib in "$PARENT"/*/; do
    sib="${sib%/}"
    name="$(basename "$sib")"
    if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$name" != "$CURRENT_VERSION" ]; then
      rm -rf "$sib" 2>/dev/null && echo "[ashlr] removed stale cache: $name" >&2 || true
    fi
  done
fi

# 3. Forward Claude Code's session id so MCP servers can attribute savings to
#    the correct per-session bucket in ~/.ashlr/stats.json. Without this, the
#    status line's "session +N" number gets clobbered across concurrent
#    terminals. We export both the canonical name and a mirror so any tool in
#    the subprocess tree can read it.
if [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  export CLAUDE_SESSION_ID
  export ASHLR_SESSION_ID="$CLAUDE_SESSION_ID"
fi

# 4. Exec the requested server script with any remaining args.
exec bun run "$@"
