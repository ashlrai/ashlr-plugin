# Parallelize TODO example inputs

The second example in the [parallelize command instructions](../commands/ashlr-parallelize.md#examples) is:

```text
/ashlr-parallelize "find all TODO comments and summarize them" hooks/pretooluse-read.ts hooks/pretooluse-bash.ts
```

| Input | Role in this invocation |
| --- | --- |
| `find all TODO comments and summarize them` | The quoted task prompt shared by each agent. |
| `hooks/pretooluse-read.ts` | A file argument assigned to one agent. |
| `hooks/pretooluse-bash.ts` | A separate file argument assigned to another agent. |

Both paths contain `/` and `.`, so they match the command's file-path rule.
The command specifies one agent per file, each receiving the same task and
its own file path. Since this example omits `--code`, those agents use the
default `ashlr:ashlr:explore` type. They are instructed to focus on their
assigned file, cite `file:line` for every claim, and keep their response under
300 words; other files may be read only if they are direct imports needed for
the task. The responses are then merged under separate file headings.

The example supplies paths to search; it does not describe the hooks' own
behavior or show TODO findings. The illustrative report in the command
instructions belongs to the first example, about module exports.
