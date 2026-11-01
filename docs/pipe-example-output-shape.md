# Pipe example output shape

The [pipe handler](../servers/pipe-server-handlers.ts) advertises
`return await ctx.grep({pattern:'TODO',cwd:'my project'});`. That expression
returns the grep tool's **text string** unchanged, including any status or
error messages. It does not receive an array of match objects. Replace
`my project` with an allowed directory. The tool is experimental and disabled
by default; see the [pipe guide](ashlr-pipe.md) for enablement and security.

The guide's [file-and-line example](ashlr-pipe.md#example-1--grep-for-todos-return-fileline-pairs)
uses that same text as input, then derives entries from it. Given this
illustrative grep text (with a final newline):

```text
src/app.ts:3:TODO first

src/config.ts:8:TODO second
```

The expression splits the string at newlines, removes empty strings, keeps
lines containing a colon, and takes the first 20 in their original order. For
each retained line it joins the first two colon-separated fields. The result
is an array of **strings**, not objects or pairs:

```json
["src/app.ts:3", "src/config.ts:8"]
```

Returning the unmodified text produces a JSON string instead; returning the
derived array produces a JSON array. The pipe serializes the expression's
return value into the handler's MCP text content. The examples above show
values, not a guarantee of specific search results or JSON whitespace.

The simple colon filter is only a heuristic. A status line such as
`status: unavailable` becomes the misleading entry `status: unavailable`,
and a colon in a path can produce an incorrect entry. Empty text or text with
no colons yields `[]`; that does not establish that the search succeeded.
Intermediate and final output limits can also make results incomplete, and
final truncation can leave invalid JSON. Inspect the original grep text when
errors or completeness matter; the guide also shows a stricter shape filter
and an example that retains the raw response.
