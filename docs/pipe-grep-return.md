# Pipe `ctx.grep` return type and empty results

`ctx.grep(args)` inside an `ashlr__pipe` expression returns the grep tool's
output as a single string. This page documents that type, the text shapes the
string can contain, and how to detect an empty result with expression syntax
the pipe allows. For enabling the tool (`ASHLR_PIPE_ENABLE=1`) and the full
security model, see [ashlr-pipe.md](ashlr-pipe.md). The behavior below is
implemented by `servers/pipe-server.ts` (execution and serialization) and
registered by `servers/pipe-server-handlers.ts` (tool description and the
opt-in flag).

## Return type

`await ctx.grep(args)` resolves to a `string`: the `ashlr__grep` tool's text
content parts concatenated into one value. It is not an array of match
objects and not parsed data — split it into lines and test each line before
extracting fields.

Two caps wrap intermediate results:

- Each intermediate tool result is capped at 64 KB; a capped result ends with
  the marker line `[ashlr__pipe: intermediate result capped at 64KB]`.
- The expression's own return value — whatever `expr` returns — is
  `JSON.stringify`-ed, then truncated to `max_output_bytes` (default 4096)
  with a trailing `[ashlr__pipe: output truncated]` marker.

## What the string can contain

| Content | When it appears |
|---|---|
| `path:line:text` lines | Ripgrep output; always this shape with `bypassSummary: true` |
| Summarized prose | Default mode can compress large result sets |
| `[no matches]` | The sentinel emitted when nothing is found |
| Status lines | `[ashlr confidence: low · bypassSummary:true to recover fidelity]`, `[embedding-cache hit \| sim=... \| grep:...]` sections, `[ashlr] genome may be stale ...` nudges |
| A refusal or error message | For example a cwd-clamp message, returned as plain text rather than thrown |

So a grep that reports no usable matches can surface as `""`, the bare
`"[no matches]"` string, `[no matches]` followed by a status line, or a
status-only string. None of these cases throws or returns a structured
empty value — they are all just text.

## Serialization of the return value

The model never sees `raw` itself unless the expression returns it. The
`expr` body's return value is serialized as JSON:

| Expression returns | Model receives |
|---|---|
| `return raw;` | A JSON string, e.g. `"src/app.ts:3:TODO\n"` |
| `return raw.split('\n');` | A JSON array of strings |
| `return [];` | `[]` |
| No `return`, or non-serializable | `null`, or `"[non-serializable result]"` |

## Handling an empty result

Supported syntax is ordinary expression-body JavaScript that passes the
deny-list: `split`, `trim`, `filter`, regex `.test`, `===`, `if`, and ternary
expressions. Identifiers such as `process`, `Bun`, `require`, `import(`,
`globalThis`, `eval`, `fetch(`, and the timer functions remain blocked, as
documented in [ashlr-pipe.md](ashlr-pipe.md#security).

### Return an empty array for no matches

Filter for `path:line:`-shaped lines first, then check the count:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const lines = raw.split('\\n').filter(l => /:\\d+:/.test(l)); if (lines.length === 0) return []; return lines.slice(0, 20);"
}
```

The `/:\d+:/` test requires digits between two colons — a line number — so
blank lines, the `[no matches]` sentinel, and status lines without that shape
are dropped before the check runs. For a response containing only the
sentinel and a status line:

```text
[no matches]
[ashlr confidence: low · bypassSummary:true to recover fidelity]
```

the pipe returns:

```json
[]
```

`[]` means no returned line had the match shape — it does not prove the
search succeeded or that there were no matches. The `:\d+:` shape is a
heuristic: a status line containing that sequence passes the filter, and a
path containing `:` can confuse field extraction. Inspect the original
output (or return it alongside, as in
[ashlr-pipe.md](ashlr-pipe.md#worked-examples)) when completeness matters.

### Return a fallback message for no matches

Compare the trimmed text against the empty string and the bare sentinel:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const text = raw.trim(); return text === '' || text === '[no matches]' ? 'No TODOs found' : raw;"
}
```

For `""`, whitespace-only output, or a bare `[no matches]` response, the pipe
returns `"No TODOs found"`. An annotated response — `[no matches]` followed
by a status line — is returned verbatim so the status stays visible for
inspection; combine the `:\d+:` filter above with a length check to collapse
those cases too.
