# Parallelize example inputs

The first example in [`/ashlr-parallelize`](../commands/ashlr-parallelize.md)
is a Claude Code slash command, entered from the project containing these files:

```text
/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts
```

The quoted phrase `explain what this module exports` is one shared task prompt,
not a file name. `servers/_pid-alive.ts` and `servers/_run-with-timeout.ts`
are two separate file arguments. Each has a `/` and a `.`, so both match the
command's file-path-like rule. The command describes the task as everything
before the first file path; file arguments follow it. It also permits an
unquoted task phrase, but path-like tokens contain `/` or `.` or start with
`__`, so avoid those in an unquoted task before the intended first file.

There is no `--code` flag in this example. The command therefore specifies two
default `ashlr:ashlr:explore` agents, one for each file, with the same task.
Each agent is instructed to focus on its assigned file, read other files only
when they are direct imports needed for the task, keep its response under 300
words, and cite `file:line` for every claim. The command instructs the host to
spawn them in parallel, wait for both, and merge their responses under separate
file headings. Its example report is illustrative; wording and line numbers
can change. Use `--code` when requesting edits, as in the command's third
example.

This example does not establish that the agents actually ran, that their
answers are complete or correct, or that execution will overlap in every host
session. It does not demonstrate quoting or parsing paths with spaces,
wildcards, duplicate paths, or missing files, nor does it define error
handling for agent failures. The command specifies errors when no file or no
task is supplied; it does not show those cases in this invocation. Consult the
[command instructions](../commands/ashlr-parallelize.md) for the full usage and
illustrative report.
