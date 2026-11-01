# Pipe grep line processing

[Example 1 in the pipe guide](ashlr-pipe.md#example-1--grep-for-todos-return-fileline-pairs)
receives `raw` as one string from `ctx.grep`. Its line processing is:

```js
const lines = raw.split('\n').filter(Boolean).filter(l => l.includes(':'));
```

In the guide's JSON request, `\\n` represents the `\n` escape in the
JavaScript expression. `split('\n')` separates on newline characters; it does
not parse grep records. For this illustrative response, including the newline
after the last line:

```text
src/app.ts:3:TODO first

status: unavailable
no colon
```

the split produces these strings in order:

```json
["src/app.ts:3:TODO first", "", "status: unavailable", "no colon", ""]
```

The blank line and trailing newline produce empty strings. `filter(Boolean)`
removes those entries, but keeps whitespace-only strings because they are
truthy. It does not trim lines. The next filter keeps every remaining string
that contains `:`, producing:

```json
["src/app.ts:3:TODO first", "status: unavailable"]
```

That colon check is not a match or line-number check: the status line survives,
while `no colon` is removed. An empty `raw` string splits into `[""]` and
produces an empty array after filtering. The expression then takes up to the
first 20 surviving lines and joins the first two colon-separated fields of each:

```json
["src/app.ts:3", "status: unavailable"]
```

The extraction assumes `path:line:text` output and paths without colons. An
empty array does not prove the search succeeded or was complete; status and
error text may be filtered out, and output can be capped. See the guide's
[empty-result example](ashlr-pipe.md#example-2--grep-for-todos-with-an-empty-result-check)
for a more selective shape check and its limits.
