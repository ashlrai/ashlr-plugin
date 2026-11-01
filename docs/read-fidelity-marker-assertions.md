# Read fidelity marker assertions

[`read-fidelity.test.ts`](../__tests__/quality/read-fidelity.test.ts) checks the
text of [`PROMPTS.read`](../servers/_summarize.ts), the instruction used when
summarizing a source file. It does not submit a file to an LLM or inspect a
summary. Its marker inventory is:

- `TODO`
- `FIXME`
- `XXX`
- `HACK`
- `WARNING`
- `THREAD-UNSAFE`
- `DEPRECATED`
- `NOTE`
- `SAFETY`

The shared-list assertion extracts the pipe-separated marker names from an
`every ... marker;` clause following `Preserve VERBATIM with line numbers:`
and checks that all nine names are present. It also demotes `DEPRECATED`,
`NOTE`, and `SAFETY` to a separate mention in a mutated prompt and checks
that they are no longer in the extracted list. Despite the test's name, this
checks prompt text, not the handling of a multi-marker input.

For every marker except `TODO`, individual regular expressions check for the
complete name in an `every ... marker;` alternation within the verbatim,
line-numbered preservation clause. Mutation assertions check that removing the
name or moving its mention outside that clause fails the relevant expression;
they also check selected longer lookalikes and removal of line-number wording.
Some check removal of `VERBATIM` or changing `every` to `some`. These are
specific examples, not an exhaustive test of all possible prompt edits.

The individual `TODO` assertion is looser: it checks for `TODO` after the
verbatim, line-numbered prefix, followed by optional marker alternatives and
`marker`. Separate assertions check that `TODO` and `FIXME` occur somewhere in
the prompt. The shared-list assertion supplies the stronger check that `TODO`
is a distinct member of the `every ... marker;` list.

The suite also checks for `@` and the word `decorator` or `annotation`, that
`@deprecated` is named among the decorator examples, export
wording, line-number wording, plain-text output, and a maximum prompt length of
800 characters. These checks do not establish that decorators or exports are
actually preserved in generated output. See the
[marker source map](summarize-marker-source-map.md) for the prompt's stated
instructions. Neither document establishes a deterministic marker matcher or
guarantees a model's fidelity, line numbers, or absence of invented markers.
