# Source summary markers

When `ashlr__read` summarizes a large source file, the summarizer gets the
`read` entry of [`PROMPTS` in `servers/_summarize.ts`](../servers/_summarize.ts#L123).
That prompt asks the model to preserve every occurrence of nine markers
verbatim with line numbers, and not to invent markers absent from the source.
This note is the one contributor reference for that marker list: what it
contains, what it does and does not promise, how to change it, and which tests
guard it.

## The list

| Marker | Common use in source annotations |
| --- | --- |
| `TODO` | Work that remains to be done. |
| `FIXME` | A problem that needs correction. |
| `XXX` | An area calling for attention or further review. |
| `HACK` | A workaround or expedient implementation. |
| `WARNING` | A caution about behavior or consequences. |
| `THREAD-UNSAFE` | A warning that code may be unsafe for concurrent use. |
| `DEPRECATED` | A feature or API marked for replacement or eventual removal. |
| `NOTE` | Context or information useful to a reader. |
| `SAFETY` | Information about a safety requirement or invariant. |

The order matches the prompt's `TODO|FIXME|...|SAFETY marker;` clause. The
descriptions are conventional uses, not rules from the prompt. The prompt gives
every marker the same preservation instruction and defines no separate meaning
for any of them; the surrounding source decides what an occurrence means.

These illustrative comments show one possible use of each marker. The wording
after each marker is an example, not a definition:

```ts
// TODO: validate the input before saving.
// FIXME: handle a failed write.
// XXX: this assumption needs review.
// HACK: use a temporary workaround for the legacy API.
// WARNING: this operation can overwrite existing data.
// THREAD-UNSAFE: callers must synchronize access to this cache.
// DEPRECATED: use the new loader instead.
// NOTE: the server returns an empty list for missing entries.
// SAFETY: the index is checked before accessing the buffer.
```

The same prompt has separate instructions that are not part of the marker
list. It asks for @-prefixed decorators and annotations (such as `@deprecated`)
with their associated symbols, verbatim with line numbers, and for top-level
export, `module.exports` and `__all__` statements by symbol name, not body.

## What it does not promise

The list is guidance to an LLM, not a deterministic detector. The prompt sets
no case, word-boundary or comment-syntax rules, and nothing guarantees that a
model keeps every marker, gets line numbers right, or invents none. When no
provider is available, the fallback keeps the head and tail of the file and can
elide markers in the middle.

So a marker missing from a summary is not evidence that the source has none.
When a marker matters, or a review has to be exhaustive, read the full file
with `bypassSummary:true`.

## Using markers in a review

Treat a preserved marker as a review cue. It can point to unfinished work, a
risk, a constraint, or context worth checking before you change the code
around it. Read the annotation and the surrounding source before you decide
what it calls for. A marker alone does not establish severity, a defect, or an
instruction to change the code.

## Changing the list

1. Compare the proposed addition, removal or spelling change with the current
   clause. Say what source annotation it covers, why that matters to a reader,
   and what could be lost or what noise it adds. Look at representative source,
   including ordinary lines without the marker, rather than assigning meaning
   from the name alone.
2. Keep the intended markers inside the "Preserve VERBATIM with line numbers"
   clause, with no duplicates, and keep the sentence against inventing absent
   markers. The prompt targets 500 characters of output, so every extra
   preservation request competes for that space.
3. Update the table and the example block above in the same PR. Their tests
   fail until they match the prompt. Investigate a failure rather than relaxing
   the test.
4. Run the marker tests listed below, then `bun run typecheck`, or
   `bun scripts/premerge-local.ts origin/main` for the tests your diff affects.

## Tests that guard it

| Test | What it checks |
| --- | --- |
| [`summarize-markers.test.ts`](../__tests__/summarize-markers.test.ts) | The prompt's marker instructions, and that the fallback keeps markers at the edges of a file but can elide one in the middle |
| [`read-marker-completeness.test.ts`](../__tests__/quality/read-marker-completeness.test.ts) | The vocabulary and the provider wiring, with a stubbed provider |
| [`read-fidelity.test.ts`](../__tests__/quality/read-fidelity.test.ts) | The prompt text, plus round trips through a local stub provider |
| [`summary-markers-doc.test.ts`](../__tests__/summary-markers-doc.test.ts) | This note's table and examples match the prompt, and its links resolve |

`read-fidelity.test.ts` mostly asserts on prompt text. Each marker must be a
whole token in the `every ... marker;` alternation inside the verbatim,
line-numbered clause, and mutation cases check that moving or removing a
marker, or dropping the line-number wording, fails. It also checks the
decorator and `@deprecated` wording, the export wording, plain-text output, the
no-invention sentence, and a ceiling of 800 characters on the prompt itself.
Its round-trip tests run `summarizeIfLarge` against a local stub provider. They
show that the marker contract reaches the request and that marker lines the
provider returns reach the summary. None of these tests calls a live LLM, so
none shows how a real model responds.
