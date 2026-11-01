# Pipe grep example: return type

The [`ashlr__pipe` handler](../servers/pipe-server-handlers.ts) advertises one
example query in its tool description and states its return type in the same
sentence. This page pins down that pair — the advertised query and the type of
value it produces — so callers know the shape to expect before writing an
expression. `ashlr__pipe` is experimental and off by default: set
`ASHLR_PIPE_ENABLE=1` in the MCP server's environment and restart the server
to register it. See the [pipe guide](ashlr-pipe.md) for the security model.

## The example query

The description's `Example:` field is the expression to pass as `expr`:

```json
{
  "expr": "return await ctx.grep({pattern:'TODO',cwd:'my project'});"
}
```

- `ctx.grep(...)` calls the registered `ashlr__grep` handler from inside the
  expression: `pattern:'TODO'` is the search text and `cwd:'my project'` is
  grep's own working-directory argument — replace it with a directory inside
  an allowed project root. It is not the optional top-level pipe `cwd`.
- `return await` yields the awaited result unchanged, so the pipe's return
  value is exactly what grep produced — no filtering or extraction.
- `ctx.grep` needs no extra opt-in; only `ctx.bash` requires the separate
  `ASHLR_PIPE_ALLOW_BASH=1` flag.

## The documented return type

The same description states that the call "returns the grep tool's text output
as a string, which may include status messages." The type differs at two
boundaries:

| Boundary | Type | Detail |
|---|---|---|
| Inside `expr`: `await ctx.grep(args)` | `string` | The wrapped tool's `content[].text` parts concatenated into one string. Match lines, the `[no matches]` sentinel, status messages, and error or refusal text all arrive as plain text — never an array of match objects or a `ToolResult` shape. |
| The `expr` return value at the MCP boundary | JSON string in one text content block | The pipe `JSON.stringify`-ies the expression's value; the handler returns it as `{ content: [{ type: "text", text }] }`. |

So `typeof (await ctx.grep(...))` is `"string"`, and the response's `text`
field is that string's JSON encoding — `JSON.parse` of it recovers the
original text, newlines included.

## Worked response

Suppose the wrapped grep produces this text — a match line followed by a
status line, with a trailing newline:

```text
my project/notes.md:7:TODO later
[ashlr confidence: low · bypassSummary:true to recover fidelity]
```

The expression returns the whole string unchanged — status line included, as
the documented type warns — so the response's `text` field is:

```json
"my project/notes.md:7:TODO later\n[ashlr confidence: low · bypassSummary:true to recover fidelity]\n"
```

## Caveats on the string type

- The string is opaque text: it can contain matches, summarized prose, the
  `[no matches]` sentinel, status lines, or error text. Split and filter it
  before treating lines as matches; see
  [pipe-grep-return.md](pipe-grep-return.md) for the empty-result patterns.
- Intermediate results are capped at 64 KB with an
  `[ashlr__pipe: intermediate result capped at 64KB]` marker line, so the
  returned string can end with that marker.
- The serialized output is truncated to `max_output_bytes` (default 4096)
  with a trailing `[ashlr__pipe: output truncated]` marker; a truncated
  `text` field is not necessarily valid JSON.
- An expression that throws surfaces through the handler's
  `ashlr__pipe error:` path as an `isError` text result — still one text
  content block, but an error string rather than grep output.

For the advertised call itself see
[pipe-server-grep-example.md](pipe-server-grep-example.md), and for the full
request-to-response trace see
[pipe-example-data-flow.md](pipe-example-data-flow.md).
