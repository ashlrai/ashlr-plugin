# Reading notes: the pipe grep example

The [pipe guide's working-directory example](ashlr-pipe.md#return-grep-output-from-a-working-directory)
and the example advertised by the [pipe handler](../servers/pipe-server-handlers.ts)
make the same call (with different spacing):

```json
{
  "expr": "return await ctx.grep({ pattern: 'TODO', cwd: 'my project' });"
}
```

The input is an `ashlr__pipe` request whose required `expr` is an async
function body. It passes `pattern: 'TODO'` and `cwd: 'my project'` to grep;
the latter is grep's working directory, not the optional top-level pipe
`cwd`. Replace it with an existing directory inside an allowed project root.
The example does not set `bypassSummary`.

`await ctx.grep(...)` resolves to the grep tool's **text output as a string**.
The expression returns that string unchanged, without extracting matches. For
example, if grep returns the following text with a trailing newline:

```text
my project/file.ts:1:TODO first
```

then the pipe response's text field contains the JSON-encoded string:

```json
"my project/file.ts:1:TODO first\n"
```

Parsing that field as JSON recovers the original string. The actual text
depends on the search and can include status or error messages, or a no-match
sentinel; it is not necessarily a list of matches. Intermediate text can be
capped, and the final serialized output can be truncated, in which case the
text field need not be valid JSON. See the [data-flow trace](pipe-example-data-flow.md)
for the response envelope and limits.

The handler registers the experimental pipe only when `ASHLR_PIPE_ENABLE=1`.
See the [guide](ashlr-pipe.md) for setup and the security model.
