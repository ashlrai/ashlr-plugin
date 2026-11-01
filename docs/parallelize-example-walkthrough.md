# Parallelize example walkthrough

The first example in the [command instructions](../commands/ashlr-parallelize.md)
is a Claude Code slash command. Enter it in a session for this repository:

```text
/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts
```

1. The quoted request, `explain what this module exports`, is the shared task:
   ask for an explanation of each module's exports. It is not a file argument.
2. `servers/_pid-alive.ts` and `servers/_run-with-timeout.ts` are two separate
   file arguments. Both match the command's path-like rule because they contain
   `/` and `.`. The instructions treat the text before the first path as the
   task; they also allow an unquoted phrase, though a path-like token in that
   phrase would mark the start of the file list.
3. There is no `--code` flag, so the instructions select the default
   `ashlr:ashlr:explore` agent type. They call for one agent per file: two
   agents, each receiving the same request and its own file path. Each prompt
   asks the agent to focus on that file, with direct imports allowed when needed,
   stay under 300 words, and cite `file:line` for every claim.
4. The instructions call for the agents to be spawned in parallel, then for
   their responses to be collected under separate file headings in a merged
   report. The footer identifies the agent count, type, and files.

This describes the command's intended flow, not an execution transcript. The
[illustrative report](../commands/ashlr-parallelize.md#illustrative-output)
is an example, not evidence that agents ran or that their responses are correct;
actual wording and line numbers can change. For the expanded per-file prompts
and limits of the example, see [parallelize example inputs](parallelize-example-inputs.md).
For an edit request, the command specifies `--code` to select
`ashlr:ashlr:code` agents instead.
