# Pipe handler: documented `ctx.grep` return type

The [`ashlr__pipe` handler registration](../servers/pipe-server-handlers.ts)
documents `ctx.grep`'s return type in the tool description it advertises to
callers. This page restates that contract and reproduces the minimal
invocation the description uses to illustrate it — it claims no capability
beyond what the handler advertises. `ashlr__pipe` is experimental and off by
default: set `ASHLR_PIPE_ENABLE=1` in the MCP server's environment and
restart the server to register it. See the [pipe guide](ashlr-pipe.md) for
the security model.

## Minimal invocation

The description's `Example:` field is the smallest advertised call — one
`ctx.grep` invocation whose result is returned unchanged:

```json
{
  "expr": "return await ctx.grep({pattern:'TODO',cwd:'my project'});"
}
```

- `ctx.grep(args)` calls the registered `ashlr__grep` handler with `args`
  verbatim: `pattern:'TODO'` is the search text and `cwd:'my project'` is
  grep's own working-directory argument — replace it with a directory inside
  an allowed project root. It is not the pipe's optional top-level `cwd`.
- `return await` yields the awaited value unchanged, so the pipe's return
  value is exactly what grep produced — no filtering or extraction.
- `ctx.grep` needs no extra opt-in; only `ctx.bash` requires the additional
  `ASHLR_PIPE_ALLOW_BASH=1` flag.

## The documented return type

The same description states that the call "returns the grep tool's text
output as a string, which may include status messages." The type differs at
two boundaries:

| Boundary | Type | Detail |
|---|---|---|
| Inside `expr`: `await ctx.grep(args)` | `string` | The wrapped tool's `content[].text` parts concatenated into one string — match lines, the `[no matches]` sentinel, status messages, or error text. Not an array of match objects and not a `ToolResult` shape. |
| The `expr` return value at the MCP boundary | JSON string in one text content block | The pipe `JSON.stringify`-ies the expression's value; the handler returns it as `{ content: [{ type: "text", text }] }`. |

So `typeof (await ctx.grep(...))` is `"string"`, and for the minimal call the
response's `text` field is that string's JSON encoding — `JSON.parse` of it
recovers the original text, newlines included.

## Worked response

Suppose the wrapped grep produces this text — a match line with a trailing
newline:

```text
src/app.ts:3:TODO fix this
```

The expression returns the string unchanged, so the response's `text` field
is:

```json
"src/app.ts:3:TODO fix this\n"
```

## Scope of this contract

- The description advertises `ctx.grep`, `ctx.read`, `ctx.ls`, and `ctx.glob`
  plus the opt-in `ctx.bash`; no other `ctx` methods are documented.
- Because the documented type is plain text, the returned string can carry
  any shape grep emits — `path:line:text` match lines, summarized prose, the
  `[no matches]` sentinel, status lines, or error text — including the status
  messages the description calls out explicitly. Split and filter it before
  treating lines as matches; see
  [pipe-grep-return.md](pipe-grep-return.md) for the empty-result patterns.
- Intermediate results are capped at 64 KB with an
  `[ashlr__pipe: intermediate result capped at 64KB]` marker line, and the
  serialized output is truncated to `max_output_bytes` (default 4096) with a
  trailing `[ashlr__pipe: output truncated]` marker — a truncated `text`
  field is not necessarily valid JSON.

For the same example's type pair see
[pipe-grep-return-type.md](pipe-grep-return-type.md), for the advertised call
itself see [pipe-server-grep-example.md](pipe-server-grep-example.md), and
for the full request-to-response trace see
[pipe-example-data-flow.md](pipe-example-data-flow.md).
