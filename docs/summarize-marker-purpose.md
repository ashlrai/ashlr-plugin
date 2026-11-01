# Source summary marker purpose

The `read` prompt in [`servers/_summarize.ts`](../servers/_summarize.ts)
instructs the model summarizing a source file to preserve every marker in this
list verbatim with line numbers:

- `TODO`
- `FIXME`
- `XXX`
- `HACK`
- `WARNING`
- `THREAD-UNSAFE`
- `DEPRECATED`
- `NOTE`
- `SAFETY`

These categories draw the model's attention to source annotations that may be
important to someone working with the code. The prompt gives them the same
preservation instruction; it does not define a separate meaning or handling
rule for each name. It also tells the model not to invent markers absent from
the source.

Separately, the prompt requests verbatim, line-numbered preservation of
@-prefixed decorators and annotations with their associated symbols. It also
requests top-level export, `module.exports`, and `__all__` statements by symbol
name, not body. These are separate instructions from the marker list.

This is prompt guidance, not a runtime marker detection rule or a guarantee
of model output. The prompt specifies no matching syntax or case rules. A
fallback may elide content, so use `bypassSummary:true` when the full source is
needed. See the [marker source map](summarize-marker-source-map.md) for the
same inventory and its source.
