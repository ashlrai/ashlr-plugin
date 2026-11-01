# Pipe server grep example

The [`ashlr__pipe` handler](../servers/pipe-server-handlers.ts) advertises this
call to return grep output directly. The tool is experimental and disabled by
default: set `ASHLR_PIPE_ENABLE=1` in the MCP server environment and restart
the server. See the [pipe guide](ashlr-pipe.md) for its security model.

Call `ashlr__pipe` with these arguments:

```json
{
  "expr": "return await ctx.grep({pattern:'TODO',cwd:'my project'});"
}
```

Replace `my project` with an existing directory inside an allowed project root.
The `cwd` here is an argument to grep, not the optional top-level pipe `cwd`.
The pattern is `TODO`; no `bypassSummary` option is supplied, so grep uses its
default behavior. No shell opt-in is needed for `ctx.grep`.

`ctx.grep` returns the grep tool's text as one string. Depending on the search,
that text can contain matches, summaries, status messages, or an error; it is
not an array of match objects. For example, if grep returns the illustrative
text `src/app.ts:3:TODO fix this\n`, the expression returns that string
unchanged. The pipe JSON-serializes it, so the MCP response's text content is:

```json
"src/app.ts:3:TODO fix this\n"
```

Parsing that content as JSON recovers the original string and newline. Actual
output varies with the directory and retrieval path. The intermediate result
can be capped, and the final serialized output is limited to 4096 bytes by
default; truncation adds a marker and can leave content that is not valid JSON.
See [the data flow](pipe-example-data-flow.md) for the response envelope and
[grep return details](pipe-grep-return.md) for more output shapes.
