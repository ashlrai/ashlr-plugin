# Reviewing the shared parallelize example

The first example in the [command instructions](../commands/ashlr-parallelize.md#examples)
and the [site documentation](../site/content/docs/skills/parallelize.mdx#examples)
is the same invocation:

```text
/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts
```

`explain what this module exports` is the shared task; `servers/_pid-alive.ts`
and `servers/_run-with-timeout.ts` are separate file arguments. With no
`--code` flag, the documented default is `ashlr:ashlr:explore`: two agents,
each receiving the same task and one file. The illustrative report in both
sources refers to this first example; it is not a record of an actual run.

## Change checklist

When changing this example, review both sources together:

- [ ] Keep the invocation's task, file arguments, order, and any `--code` flag
  aligned in both Examples blocks. Check that the task is distinct from the
  file paths and that each path meets the documented path-like rule.
- [ ] Check that each referenced file exists and that the task makes sense for
  every file. If the flag changes, check the documented agent type as well.
- [ ] Update the explanatory text and illustrative report in both sources:
  the task, per-file headings, agent count, type, and footer file list must
  agree with the invocation. Review example claims and citations against the
  files; wording and line numbers may change.
- [ ] Update the related [walkthrough](parallelize-example-walkthrough.md),
  [input guide](parallelize-example-inputs.md), and
  [command examples](ashlr-command-examples.md) when their copies or
  explanations are affected. Do not confuse this example with the separate
  TODO-search example.
- [ ] Run the checks below and review failures before accepting the change.
  These checks help detect drift; they do not verify that agents ran or that
  their illustrative answers are correct.

```sh
bun test __tests__/parallelize-example-review.test.ts \
  __tests__/parallelize-example-parity.test.ts \
  __tests__/parallelize-example-inputs.test.ts \
  __tests__/parallelize-example-walkthrough.test.ts
```
