# Comparing the parallelize TODO-search examples

The [command instructions](../commands/ashlr-parallelize.md#examples) and
the [site documentation](../site/content/docs/skills/parallelize.mdx#examples)
show the same second example, with no differences in the invocation:

```text
/ashlr-parallelize "find all TODO comments and summarize them" hooks/pretooluse-read.ts hooks/pretooluse-bash.ts
```

| Input or behavior | Both sources specify |
| --- | --- |
| Shared task | `find all TODO comments and summarize them` |
| File arguments | `hooks/pretooluse-read.ts` and `hooks/pretooluse-bash.ts`, separately |
| Agent selection | No `--code` flag, so use `ashlr:ashlr:explore` |
| Dispatch | Two agents, one per file, receive the same task and their own file path |
| Result | Wait for both responses and merge them under separate file headings, with an agent-count, type and file-list footer |

Both file paths match the stated path-like rule: they contain `/` and `.`.
Each agent is instructed to focus on its assigned file, read other files only
if they are direct imports needed for the task, keep its response under 300
words, and cite `file:line` for every claim. This is a read-only search; the
sources recommend `--code` for edits.

Both sources also show the same illustrative report, but that report belongs
to the **first** example about module exports, not this TODO search. Neither
source shows actual TODO findings or proves that the agents ran, that their
search was complete, or that their answers were correct. The examples do not
specify how failures from an agent are handled.
