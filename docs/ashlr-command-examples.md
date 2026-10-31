# Illustrative slash-command output

These examples are illustrative, not transcripts or guarantees. Agent wording,
citations, versions, counts, and output depend on the repository, session, and
installed version. Run slash commands inside Claude Code; they are instructions
to the host, not shell commands. See the [command reference](commands.md) for
the complete catalog and follow each linked command for prerequisites and side
effects.

## Analyze files in parallel

[`/ashlr-parallelize`](../commands/ashlr-parallelize.md) applies one shared
task to each file with one agent per file. This read-only invocation uses the
default `ashlr:ashlr:explore` agents:

See the [input walkthrough](parallelize-example-inputs.md) for how the task
and file arguments are interpreted and what the example does not establish.

```text
/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts
```

Illustrative merged report (citations and line numbers can change):

```text
## /ashlr-parallelize — 2 agents · task: explain what this module exports

### servers/_pid-alive.ts
Exports `pidAlive`, which checks whether a process is alive (servers/_pid-alive.ts:18).

### servers/_run-with-timeout.ts
Exports the `RunWithTimeoutOptions` interface (servers/_run-with-timeout.ts:76), the `RunWithTimeoutResult` interface (servers/_run-with-timeout.ts:93), and `runWithTimeout` to run a subprocess with a timeout (servers/_run-with-timeout.ts:142).

---
Agents: 2 · subagent_type: ashlr:ashlr:explore · files: servers/_pid-alive.ts, servers/_run-with-timeout.ts
```

For edits, add `--code` to select `ashlr:ashlr:code` agents instead:

```text
/ashlr-parallelize --code "add JSDoc to all exported functions" servers/read-server.ts servers/grep-server.ts
```

The merged report has the same per-file structure and a footer with
`subagent_type: ashlr:ashlr:code`. With no file arguments or no task, the
command stops before spawning agents. For example:

```text
/ashlr-parallelize "explain exports"
No files specified. Usage: /ashlr-parallelize <task> <file1> [file2] ...
```

## Set a token budget

[`/ashlr-budget`](../commands/ashlr-budget.md) sets a session cap; setting a
token cap clears any USD cap. The guard warns at 80% and 95%, and blocks at
100%. Illustrative confirmation:

```text
/ashlr-budget tokens=200000
Budget set to 200000 tokens.
```

Use `/ashlr-budget status` to inspect usage and `/ashlr-budget off` to clear
the cap.

## Check an empty orchestration cache

[`/ashlr-orchestrate-status`](../commands/ashlr-orchestrate-status.md) reads
the local cache without running a graph. With no cached runs, illustrative output
is:

```text
/ashlr-orchestrate-status
No orchestration runs yet — use /ashlr-orchestrate to start.
```

For populated-cache examples and a reproducible synthetic fixture, see
[representative command output](command-output-q8.md).
