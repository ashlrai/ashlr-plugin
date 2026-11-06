# Source summary marker examples

The `read` prompt in [`servers/_summarize.ts`](../servers/_summarize.ts)
asks the model to preserve every listed marker verbatim with line numbers and
not to invent markers absent from the source. These illustrative source
comments show one possible use of each listed marker:

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

The wording after each marker is an example, not a definition or a prescribed
response. The prompt does not specify case, boundaries, or comment syntax for
matching. It is guidance to an LLM, not a deterministic detector or a guarantee
that markers will appear in the summary. A fallback can also elide source
content; use `bypassSummary:true` when the full source is needed. See the
[marker source map](summarize-marker-source-map.md) for the inventory.
