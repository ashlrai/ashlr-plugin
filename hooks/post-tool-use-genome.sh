#!/usr/bin/env bash
# ashlr-plugin PostToolUse: auto-propose genome updates.
#
# Streams the PostToolUse JSON payload into scripts/genome-auto-propose.ts,
# which decides whether to append a proposal to the nearest `.ashlrcode/
# genome/proposals.jsonl`. This is a fire-and-forget observer: it must NEVER
# block the agent and must NEVER emit output on stdout (the harness reads
# stdout as hook JSON).
#
# Honors:
#   ASHLR_GENOME_AUTO=0          — env-var kill switch
#   ~/.ashlr/config.json         — { "genomeAuto": false } disables
#   ~/.claude/settings.json      — user-level global settings (handled in TS)

set +e

# Short-circuit before we even spawn Bun if the user disabled auto-genome.
if [ "${ASHLR_GENOME_AUTO:-1}" = "0" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
PROPOSE_TS="$PLUGIN_ROOT/scripts/genome-auto-propose.ts"

# No bun or missing script → pass through without error.
if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$PROPOSE_TS" ]; then
  exit 0
fi

# Pipe stdin through; suppress stdout so we don't pollute the hook channel.
bun run "$PROPOSE_TS" >/dev/null 2>&1 || true

exit 0
