---
name: ashlr-orchestrate-status
description: Inspect past /ashlr-orchestrate runs — list recent runs or drill into a single graph by id.
---

## Description

`/ashlr-orchestrate-status` reads the local orchestration result cache under `~/.ashlr/orchestrations/` and renders either a flat table of recent runs (default) or a per-node tree for a single graph. Each `/ashlr-orchestrate` run saves a `result.json` there (best-effort), so this command works fully offline with no network or telemetry side-effects.

The cache is pruned to the 50 most-recent runs on every write, so disk usage stays bounded without manual cleanup.

## Usage examples

```bash
# Show a table of the 10 most-recent runs
/ashlr-orchestrate-status

# Drill into a single run by its full graph id (a UUID)
/ashlr-orchestrate-status 2d13367f-82d8-4d82-a5d8-7383b291efcc

# Dump raw JSON (list mode or detail mode) for piping to jq
/ashlr-orchestrate-status --json
/ashlr-orchestrate-status --json 2d13367f-82d8-4d82-a5d8-7383b291efcc

# Show more than 10 rows
/ashlr-orchestrate-status --last 25
```

## Output

List mode prints a fixed-width table with one row per run, newest first. Graph ids longer than 24 characters are cut with `…`, so copy the full id from `--json` or from the `~/.ashlr/orchestrations/` directory name:

```
graph-id                  ok      startedAt               tokens    goal
------------------------  ------  ----------------------  --------  ------------------------
7ee3f054-ccd7-46b5-9ff3…  ok      2026-11-22T17:29:46.36  6250      add retry logging
2d13367f-82d8-4d82-a5d8…  ok      2026-11-22T17:29:46.04  6250      add retry logging

2 of 2 runs shown
```

Detail mode renders a per-node tree with each node's agent kind:

```
Run 2d13367f-82d8-4d82-a5d8-7383b291efcc
  goal:       add retry logging
  tier:       pro
  ok:         true
  startedAt:  2026-11-22T17:29:46.044Z
  finishedAt: 2026-11-22T17:29:46.242Z
  duration:   198ms
  tokens:     6250
  nodes:
    ├─ [ok]   node-servers       (refactorer, 123ms, 2200 tokens)
    ├─ [ok]   node-docs          (doc-writer, 122ms, 2000 tokens)
    └─ [ok]   node-scripts       (refactorer, 73ms, 2050 tokens)
```

A run with an empty graph shows `(none)` under `nodes:`. Failed nodes get a `[fail]` tag and an `error:` line.

When the cache is empty: `No orchestration runs yet — use /ashlr-orchestrate to start.` (exit 0; `--json` prints `[]`).
When an id is given but not found: `No run found with id <graph-id>` (exit 1).
When an id contains anything other than letters, digits, `-` or `_`: `Invalid graph id "<id>" — must be alphanumeric + hyphen/underscore.` (exit 1).
Malformed `result.json` files are skipped with a one-line stderr warning.

## Invocation

Run via Bash:

```sh
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/cli-orchestrate-status.ts "$ARGUMENTS"
```

Pass `$ARGUMENTS` through verbatim. Print the stdout inside a fenced code block so the table aligns.
