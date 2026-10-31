# Pipe grep example walkthrough

This walks through [Example 1 in the pipe guide](ashlr-pipe.md#example-1--grep-for-todos-return-fileline-pairs), which searches for TODOs and returns file-and-line strings. The example request is:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const lines = raw.split('\\n').filter(Boolean).filter(l => l.includes(':')); return lines.slice(0, 20).map(l => l.split(':').slice(0,2).join(':'));"
}
```

`pattern: 'TODO'` supplies the text to search for; `cwd: '.'` specifies the
working directory and `bypassSummary: true` is passed to grep. The awaited
result, `raw`, is one text string. Its contents depend on the search; the
following is the guide's illustrative result, with a blank line between the
two matches and a newline after the last one:

```text
/project/src/app.ts:42:// TODO: validate input

/project/src/config.ts:7:// TODO: load defaults
```

1. `raw.split('\n')` splits the string at newline characters. The blank line
   and trailing newline each produce an empty string. In the JSON request,
   `\\n` encodes the `\n` used in the JavaScript expression.
2. `filter(Boolean)` removes those empty strings. `filter(l => l.includes(':'))`
   then retains lines containing a colon; it does not check whether they are
   matches or whether the second field is a line number.
3. `slice(0, 20)` keeps at most the first 20 remaining lines in their original
   order. For each, `split(':').slice(0,2).join(':')` takes the first two
   colon-separated fields and joins them back together.

For the illustrative result above, the returned value is a JSON array of
strings:

```json
["/project/src/app.ts:42", "/project/src/config.ts:7"]
```

If no lines contain a colon, the result is `[]`. This extraction assumes
`path:line:text` output and paths without colons. Other output containing
colons, including status messages, can also produce entries; the array alone
does not establish that a search succeeded or that its results are complete.
