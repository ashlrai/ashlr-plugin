# Pipe grep walkthrough

An end-to-end walk through the grep example that the
[pipe handler](../servers/pipe-server-handlers.ts) advertises and the
[pipe guide](ashlr-pipe.md#return-grep-output-from-a-working-directory)
documents. This page only explains existing behavior; it changes nothing in
the server.

## 1. Enable the tool

`ashlr__pipe` registers only when `ASHLR_PIPE_ENABLE=1` is set before the
server starts. Without it, the handler module is a no-op.

## 2. The request

```json
{
  "expr": "return await ctx.grep({ pattern: 'TODO', cwd: 'my project' });"
}
```

`expr` is an async function body. `ctx.grep` forwards its argument object to
the `ashlr__grep` tool; `cwd: 'my project'` is grep's working directory (use a
real directory inside an allowed project root). The expression returns
whatever grep returned, with no extraction.

## 3. What happens

1. The handler calls `ashlrPipe(args, ctx)`, which checks the deny-list and
   runs `expr` inside an `AsyncFunction`.
2. `ctx.grep(...)` calls the registered `ashlr__grep` handler and joins its
   text content blocks into **one string**.
3. The expression returns that string.
4. `ashlrPipe` serializes the return value with `JSON.stringify`, truncates it
   to `max_output_bytes` (default 4096) with an `[ashlr__pipe: output truncated]`
   marker if needed, and the handler wraps it in one MCP text content block.

## 4. The string result

If grep's text is:

```text
my project/file.ts:1:TODO first
```

then the block's `text` is the JSON encoding of that string, quotes and escapes
included:

```json
"my project/file.ts:1:TODO first\n"
```

Parse `text` once to recover the grep output. The value is a string, not an
array of matches: it may contain status or error lines, or a no-match marker,
depending on the search. If output was truncated, `text` may not be valid JSON.

## 5. Going further

To turn the string into entries, split it inside the expression. See
[pipe-grep-example-walkthrough.md](pipe-grep-example-walkthrough.md) and
[pipe-grep-return.md](pipe-grep-return.md).
