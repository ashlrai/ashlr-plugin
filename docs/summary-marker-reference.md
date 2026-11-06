# Source summary marker reference

The `read` prompt in [`servers/_summarize.ts`](../servers/_summarize.ts) asks
the model summarizing a source file to preserve each of the following markers
verbatim with line numbers, and not to invent markers absent from the source.
The descriptions below are conventional uses, not separate rules defined by
the prompt; the source context determines what a particular occurrence means.

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

This is model guidance, not a deterministic detector or a guarantee that a
summary will preserve every occurrence. The prompt does not specify matching
syntax, case sensitivity, or comment boundaries. It separately asks for
@-prefixed decorators and annotations with their associated symbols and line
numbers, and for top-level export, `module.exports`, and `__all__` statements
by symbol name. Those are separate from the marker list.

Fallback truncation can elide content. When the complete source is needed, use
`bypassSummary:true` to request it.
