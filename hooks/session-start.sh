#!/usr/bin/env bash
# Runs when Claude Code starts a session with ashlr-plugin active.
# Only prints the activation notice the first time per day.

STAMP="$HOME/.ashlr/last-announce"
mkdir -p "$(dirname "$STAMP")"

TODAY=$(date +%Y-%m-%d)
LAST=$(cat "$STAMP" 2>/dev/null || echo "")

if [ "$LAST" != "$TODAY" ]; then
  echo "ashlr-plugin v0.1.0 active — ashlr__read / ashlr__grep / ashlr__edit available. /ashlr-savings to see totals."
  echo "$TODAY" > "$STAMP"
fi
