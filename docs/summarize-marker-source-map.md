# Summarization marker source map

The `read` entry of [`PROMPTS`](../servers/_summarize.ts) instructs an LLM
summarizing a source file to preserve every marker in the following list
verbatim, with line numbers. It also instructs the model not to invent markers
absent from the source. These names share that stated purpose; the prompt does
not give individual definitions for them.

- `TODO`
- `FIXME`
- `XXX`
- `HACK`
- `WARNING`
- `THREAD-UNSAFE`
- `DEPRECATED`
- `NOTE`
- `SAFETY`

This is an instruction to the model, not a specification of a deterministic
marker matcher. The prompt does not define case sensitivity, word boundaries,
comment syntax, or other matching rules, and it does not guarantee that a model
will preserve every marker. It separately asks for @-prefixed decorators and
annotations, with their associated symbols, to be preserved verbatim with line
numbers; those examples are not part of the marker list above.
