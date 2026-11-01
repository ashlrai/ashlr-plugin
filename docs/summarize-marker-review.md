# Reviewing source summary markers

The `read` prompt in [`servers/_summarize.ts`](../servers/_summarize.ts) asks
the summarizer to preserve these markers verbatim with line numbers:

- `TODO`
- `FIXME`
- `XXX`
- `HACK`
- `WARNING`
- `THREAD-UNSAFE`
- `DEPRECATED`
- `NOTE`
- `SAFETY`

Treat these markers as **review cues**: they can point to unfinished work,
risks, constraints, or context worth checking when changing the surrounding
code. Read the actual annotation and surrounding source before deciding what
action it calls for. A marker alone does not establish severity, a defect, or
an instruction to change the code; its meaning depends on context.

The prompt tells the model not to invent markers absent from the source. It
separately asks for @-prefixed decorators and annotations with their associated
symbols and line numbers; those are not the marker list above.

This is guidance to a model, not deterministic marker detection or a
guarantee that every marker will survive summarization. The prompt does not
specify matching syntax or case rules. A fallback can also elide the middle of
the source. If a cue matters to the review, or an exhaustive review is needed,
read the full file using `bypassSummary:true`; absence from a summary is not
evidence that the source contains no markers.
