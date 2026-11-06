# Pipe grep example output

The `ashlr__pipe` handler advertises `return await ctx.grep({pattern:'TODO',cwd:'my project'});`.
That call returns the grep tool's text output as a **string**, which may
contain status messages. The pipe serializes the returned string as JSON; it
does not return an array of match objects. The actual text depends on the
directory, pattern, and search results. For setup and the complete examples,
see [the pipe guide](ashlr-pipe.md).

The guide's first filtering example uses the same string interface:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const lines = raw.split('\\n').filter(Boolean).filter(l => l.includes(':')); return lines.slice(0, 20).map(l => l.split(':').slice(0,2).join(':'));"
}
```

For illustration only, suppose grep returns the following string, with a
trailing newline after the last line:

```text
src/app.ts:3:TODO first

src/config.ts:8:TODO second
```

`split('\n')` divides the string at newlines. `filter(Boolean)` removes
empty strings, including the blank line and the entry after the trailing
newline; it does not remove whitespace-only lines. The next filter keeps lines
containing a colon. The expression takes at most the first 20 remaining lines,
preserving order, and joins the first two colon-separated fields of each line.
For the illustrative input, the serialized return value is:

```json
["src/app.ts:3", "src/config.ts:8"]
```

This is an array of strings because the expression returns an array; returning
`raw` directly would instead serialize a JSON string. An empty string or a
response with no colons yields `[]`. The colon filter is not a match parser:
a status or error line containing a colon can pass it, and paths containing
colons can be split incorrectly. An empty array does not prove the search
succeeded. Output may also be capped, so inspect the original response when
errors or completeness matter. The guide's [empty-result example](ashlr-pipe.md#example-2--grep-for-todos-with-an-empty-result-check)
shows a stricter line-shape heuristic and its limits.
