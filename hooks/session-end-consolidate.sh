#!/usr/bin/env bash
# ashlr-plugin SessionEnd: consolidate pending genome proposals.
#
# Invoked by Claude Code on session shutdown. Hands off to
# scripts/genome-auto-consolidate.ts which reads proposals.jsonl in the
# current project's genome, merges them into their target sections, and
# truncates the queue.
#
# Best-effort: a failed consolidation should never disturb the user's
# session exit. All output goes to stderr; the hook exits 0 always.

set +e

if [ "${ASHLR_GENOME_AUTO:-1}" = "0" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
CONSOLIDATE_TS="$PLUGIN_ROOT/scripts/genome-auto-consolidate.ts"

if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$CONSOLIDATE_TS" ]; then
  exit 0
fi

TARGET_DIR="${PROJECT_ROOT:-$PWD}"

# Run in background so session teardown isn't delayed by filesystem latency.
# The script is idempotent and bounded, so fire-and-forget is safe.
bun run "$CONSOLIDATE_TS" --dir "$TARGET_DIR" 1>&2 2>/dev/null &

exit 0
