---
name: ashlr-handoff
description: Generate a context-pack for the next session to resume cold.
argument-hint: ""
---

Generate a plain-text handoff that can be pasted into a fresh Claude Code
session. Renders branch/dirty state, last 5 commits, genome state, top
session tools, and top lifetime projects — all in ASCII so it copies
cleanly.

Run via Bash:

```sh
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/savings-dashboard.ts --handoff
```

Print the script's stdout verbatim — do not paraphrase. The output is
designed to be copy-pasted, so any reformatting from this skill weakens
the handoff.

If the script fails, fall back to telling the user:
`/ashlr-dashboard --handoff failed — run git log and check status line.`
