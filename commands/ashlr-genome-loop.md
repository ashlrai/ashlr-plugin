---
name: ashlr-genome-loop
description: Inspect and control the automatic genome propose + consolidate loop (PostToolUse observer + SessionEnd consolidator).
---

The ashlr-plugin runs an automatic genome loop: a PostToolUse hook proposes
architecture/decision-flavored observations to
`.ashlrcode/genome/proposals.jsonl`, and a SessionEnd hook consolidates them
back into section files when ≥ 3 are pending. This command exposes the
loop's status and on/off state.

Subcommands (arg to the slash command):

- `status` — show pending proposal count, last consolidation timestamp, and
  whether the loop is currently enabled.
- `run` — force a consolidation pass on the current project's genome.
- `on` — enable the loop (writes `~/.ashlr/config.json`).
- `off` — disable the loop (writes `~/.ashlr/config.json`). The
  `ASHLR_GENOME_AUTO=0` env var also disables it per-shell.

Dispatch on `$1`:

### If `$1` is empty or `status`

Run the following Bash command and relay the output:

```bash
bash -c '
set -e
CFG="$HOME/.ashlr/config.json"
LOG="$HOME/.ashlr/genome-consolidation.log"
GENOME="$(pwd)/.ashlrcode/genome"
PROPOSALS="$GENOME/proposals.jsonl"

ENABLED="on"
if [ "${ASHLR_GENOME_AUTO:-1}" = "0" ]; then ENABLED="off (env ASHLR_GENOME_AUTO=0)"; fi
if [ -f "$CFG" ] && grep -q "\"genomeAuto\"[[:space:]]*:[[:space:]]*false" "$CFG" 2>/dev/null; then
  ENABLED="off (~/.ashlr/config.json)"
fi

PENDING=0
if [ -f "$PROPOSALS" ]; then
  PENDING=$(grep -c . "$PROPOSALS" 2>/dev/null || echo 0)
fi

LAST="(never)"
if [ -f "$LOG" ]; then
  LAST=$(tail -n 1 "$LOG" 2>/dev/null | awk "{print \$1}")
  [ -z "$LAST" ] && LAST="(never)"
fi

echo "ashlr genome loop — $ENABLED"
echo "  pending proposals: $PENDING ($PROPOSALS)"
echo "  last consolidation: $LAST"
'
```

### If `$1` is `run`

Run the following Bash command and relay its output verbatim:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/genome-auto-consolidate.ts --dir "$(pwd)"
```

If no output appears, say "No pending proposals to consolidate (need ≥ 3)."

### If `$1` is `on`

Run the following Bash command:

```bash
bash -c '
mkdir -p "$HOME/.ashlr"
CFG="$HOME/.ashlr/config.json"
if [ -f "$CFG" ]; then
  bun -e "
    const fs = require(\"fs\");
    const p = process.env.HOME + \"/.ashlr/config.json\";
    let j = {};
    try { j = JSON.parse(fs.readFileSync(p, \"utf-8\")); } catch {}
    j.genomeAuto = true;
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
    console.log(\"ashlr genome loop: enabled\");
  "
else
  echo "{\"genomeAuto\": true}" > "$CFG"
  echo "ashlr genome loop: enabled"
fi
'
```

### If `$1` is `off`

Run the following Bash command:

```bash
bash -c '
mkdir -p "$HOME/.ashlr"
CFG="$HOME/.ashlr/config.json"
if [ -f "$CFG" ]; then
  bun -e "
    const fs = require(\"fs\");
    const p = process.env.HOME + \"/.ashlr/config.json\";
    let j = {};
    try { j = JSON.parse(fs.readFileSync(p, \"utf-8\")); } catch {}
    j.genomeAuto = false;
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
    console.log(\"ashlr genome loop: disabled\");
  "
else
  echo "{\"genomeAuto\": false}" > "$CFG"
  echo "ashlr genome loop: disabled"
fi
'
```

No preamble, no trailing summary beyond the command output.
