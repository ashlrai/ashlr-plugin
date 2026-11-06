# Parallelize command documentation locations

`/ashlr-parallelize` is documented in two places:

| Location | Role |
| --- | --- |
| [`commands/ashlr-parallelize.md`](../commands/ashlr-parallelize.md) | Slash-command instructions shipped with the plugin. Its frontmatter sets `name`, `description`, and `argument-hint`; the host reads the body as the command's instructions. |
| [`site/content/docs/skills/parallelize.mdx`](../site/content/docs/skills/parallelize.mdx) | The public documentation page, built from `site/content/docs/` (see the [docs index](README.md)). Its frontmatter sets `title` and `description` for the site. |

After the frontmatter the two files are identical: the same usage line,
argument rules, examples, steps, merged-report template, and illustrative
output. Editing one does not update the other, so changes must land in both;
`__tests__/commands/ashlr-parallelize.test.ts` checks the bodies match and
`__tests__/parallelize-example-parity.test.ts` checks the examples agree.

Both files list the same first example invocation:

```text
/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts
```

The quoted phrase is one task shared by every agent; the two paths are
separate file arguments, so the command dispatches two
`ashlr:ashlr:explore` agents, one per file, and merges their answers under
per-file headings. The remaining two invocations in the `## Examples` block
also match across both files.

For the request walkthrough see [parallelize example walkthrough](parallelize-example-walkthrough.md),
for the expanded per-file prompts see [parallelize example inputs](parallelize-example-inputs.md),
and for the second (TODO-search) invocation see [comparing the parallelize examples](parallelize-example-comparison.md).
