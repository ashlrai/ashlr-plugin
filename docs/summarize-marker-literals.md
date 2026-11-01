# Source summary marker literals

The `read` prompt in [`servers/_summarize.ts`](../servers/_summarize.ts)
asks the model to preserve every occurrence of these markers verbatim with
line numbers:

- `TODO`
- `FIXME`
- `XXX`
- `HACK`
- `WARNING`
- `THREAD-UNSAFE`
- `DEPRECATED`
- `NOTE`
- `SAFETY`

The prompt also says not to invent markers absent from the source. It separately
requests preservation of @-prefixed decorators and annotations with their
associated symbols and line numbers; those are not part of the list above.

These are instructions to an LLM, not deterministic matching rules or a guarantee
that every marker will appear in a summary. If the provider is unavailable, the
fallback can elide content in the middle. Use `bypassSummary:true` when the full
source is needed. See also the [marker source map](summarize-marker-source-map.md).
