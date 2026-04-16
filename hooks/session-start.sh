#!/usr/bin/env bash
# ashlr session-start bash entrypoint.
#
# Thin wrapper around scripts/session-greet.ts — all real logic lives in TS.
# Handles:
#   - ASHLR_QUIET=1 → skip greeting entirely (still let the TS script update
#     session-state.json so the first-run detector stays accurate).
#   - No Bun on PATH → degrade gracefully with a one-line plain-text notice.
#
# Output goes to stderr (greetings don't belong on stdout where hook JSON
# payloads live). Never exits non-zero — the greeting is decoration, not a
# gate on session start.

set +e  # never fail a session over a greeting

# Resolve the plugin root from this script's location so the wrapper works
# whether invoked via Claude Code ($CLAUDE_PLUGIN_ROOT) or directly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
GREET_TS="$PLUGIN_ROOT/scripts/session-greet.ts"

# Short-circuit on explicit quiet. We intentionally still run the TS path
# even under ASHLR_QUIET so state updates happen — but only if bun is present.
# (No bun + quiet = do absolutely nothing, which is correct.)
if command -v bun >/dev/null 2>&1; then
  if [ -f "$GREET_TS" ]; then
    bun run "$GREET_TS" 2>&1 1>&2
    exit 0
  fi
fi

# Fallback path: bun or the greet script isn't available. Print a minimal
# one-liner on stderr once per day so the user knows the plugin is loaded.
if [ -z "$ASHLR_QUIET" ]; then
  STAMP="$HOME/.ashlr/last-announce"
  mkdir -p "$(dirname "$STAMP")" 2>/dev/null
  TODAY=$(date +%Y-%m-%d)
  LAST=$(cat "$STAMP" 2>/dev/null || echo "")
  if [ "$LAST" != "$TODAY" ]; then
    echo "ashlr-plugin active — install bun (https://bun.sh) to unlock the full session greeting." 1>&2
    echo "$TODAY" > "$STAMP" 2>/dev/null
  fi
fi

exit 0
