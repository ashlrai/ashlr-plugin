# Parallelize example reference

Quick reference for the shared TODO-search example of `/ashlr-parallelize`. The
same example appears in two places, and the two copies must stay identical.

| Location | Section |
| --- | --- |
| [`commands/ashlr-parallelize.md`](../commands/ashlr-parallelize.md#examples) | `## Examples`, second invocation |
| [`site/content/docs/skills/parallelize.mdx`](../site/content/docs/skills/parallelize.mdx) | `## Examples`, second invocation |

## The shared example

```text
/ashlr-parallelize "find all TODO comments and summarize them" hooks/pretooluse-read.ts hooks/pretooluse-bash.ts
```

## Input files

| Input | Role |
| --- | --- |
| `find all TODO comments and summarize them` | Task prompt applied by every agent. |
| `hooks/pretooluse-read.ts` | File searched by the first agent. |
| `hooks/pretooluse-bash.ts` | File searched by the second agent. |

The example has no `--code` flag, so it runs two read-only
`ashlr:ashlr:explore` agents, one per file. It supplies inputs only: the
command docs show no TODO findings for it (their illustrative report belongs to
the first, module-exports example).

## Related notes

- [Input guide for the TODO example](parallelize-todo-example-inputs.md)
- [Where the example is documented](parallelize-command-locations.md)
- [Review checklist](parallelize-example-review.md)
