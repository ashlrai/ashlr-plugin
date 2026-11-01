---
name: ashlr-pipe
description: Run a multi-step JS expression that calls grep/read/bash/ls/glob internally — intermediate results never enter context, only the return value does.
---

## Overview

`ashlr__pipe` lets you run a JavaScript async expression that orchestrates multiple ashlr tool calls in a single round-trip. Intermediate results (grep output, file contents, bash stdout) are computed server-side and **never sent to the model context** — only the expression's final return value does. Typical savings: **80–95%** vs calling the same tools individually.

**Experimental and opt-in:** `ashlr__pipe` is off by default. Set
`ASHLR_PIPE_ENABLE=1` in the MCP server's environment before starting it to
register the tool. Shell access requires the separate `ASHLR_PIPE_ALLOW_BASH=1`
opt-in described below.

### When to use it

- You need to grep for a pattern, then filter/transform the results
- You need to read several files and extract one fact from each
- You need to bash-query something and do arithmetic on the result
- Any pipeline where you'd otherwise burn context on large intermediate strings

---

## Security model & status

**Status: EXPERIMENTAL.** `ashlr__pipe` executes model-authored JavaScript code server-side. It is **off by default** in all releases.

### Flags

| Flag | Effect |
|---|---|
| `ASHLR_PIPE_ENABLE=1` | Registers the tool. Required to use `ashlr__pipe` at all. |
| `ASHLR_PIPE_ALLOW_BASH=1` | Adds `ctx.bash` to the expression context. Requires `ASHLR_PIPE_ENABLE=1`. |

These are two separate, independent opt-ins. Enabling the pipe feature does **not** automatically expose shell access.

### Default ctx — read-only tools only

By default `ctx` exposes only non-mutating, non-shell tools:

| Available by default | Requires `ASHLR_PIPE_ALLOW_BASH=1` |
|---|---|
| `ctx.grep`, `ctx.read`, `ctx.ls`, `ctx.glob` | `ctx.bash` |

If an expression calls `ctx.bash` without the flag set it receives a clear error:
```
ctx.bash is disabled; set ASHLR_PIPE_ALLOW_BASH=1 to enable shell access in pipes
```

### Deny-list (best-effort)

Before execution, the expression is checked against a deny-list of blocked tokens: `process`, `Bun`, `require`, `import(`, `globalThis`, `__proto__`, `constructor[`, `eval`, `Function(`, `setTimeout`, `setInterval`, `fetch(`. This is a best-effort guardrail, **not a true sandbox**. The AsyncFunction constructor prevents module-closure access; strict mode (`"use strict"` is prepended automatically) makes `this` undefined so token-splitting attacks (`this["pro"+"cess"]`) fail at runtime.

### Rollout flag

`ashlr__pipe` is **disabled by default**. Enable it per-session:

```sh
ASHLR_PIPE_ENABLE=1 claude
```

To enable it in an MCP client configuration, add this setting to the Ashlr
server's `env` object, preserving any existing settings, and restart the server:

```json
{
  "ASHLR_PIPE_ENABLE": "1"
}
```

---

## Tool schema

```
ashlr__pipe(
  expr:             string   — async function body, ≤2000 chars (required)
  cwd?:             string   — working directory for tool calls
  timeout_ms?:      number   — default 10000, hard max 30000
  max_output_bytes? number   — default 4096 (truncates serialized return value)
)
```

`expr` receives a single argument `ctx` with these async methods:

| Method | Equivalent tool | Args | Example output |
|---|---|---|---|
| `ctx.grep(args)` | `ashlr__grep` | `{ pattern, cwd?, bypassSummary?, ... }` | `ctx.grep({ pattern: 'TODO', cwd: '.' })` → `"src/app.ts:3:TODO first\nsrc/config.ts:8:TODO second\n"` |
| `ctx.read(args)` | `ashlr__read` | `{ path, bypassSummary? }` | Numbered file lines |
| `ctx.bash(args)` | `ashlr__bash` | `{ command, cwd?, timeout_ms? }` | Command stdout |
| `ctx.ls(args)` | `ashlr__ls` | `{ path? }` | Directory listing |
| `ctx.glob(args)` | `ashlr__glob` | `{ pattern, cwd? }` | One matching path per line |

Each method returns the tool's text output as a plain string. The grep example
above is representative of the `path:line:text` shape only — it is not a fixed
result: paths, line numbers, and any status lines depend on the repository and
pattern searched. See [pipe-grep-return.md](pipe-grep-return.md) for the
`ctx.grep` return type and how to handle an empty result.

### Security

Before execution the expression is checked against a deny-list of blocked tokens:
`process`, `Bun`, `require`, `import(`, `globalThis`, `__proto__`, `constructor[`, `eval`, `Function(`, `setTimeout`, `setInterval`, `fetch(`.

The function is built with `AsyncFunction` (not `eval`) so module-level closures and `require` are inaccessible regardless of the deny-list.

### Return value

- The expression must `return` a value.
- The return value is `JSON.stringify`-ed. Non-serializable values (circular refs, BigInt) return `"[non-serializable result]"`.
- Output is truncated to `max_output_bytes` with a `[ashlr__pipe: output truncated]` marker.

---

## Worked examples

### Return grep output from a working directory

Search for `TODO` in an explicit directory (replace `my project` with an
existing directory within an allowed project root):

```json
{
  "expr": "return await ctx.grep({ pattern: 'TODO', cwd: 'my project' });"
}
```

`ctx.grep` returns the grep tool's text output as a string. Its contents depend
on the search and may include matches or status messages, including when no
matches are found. The pipe serializes that string as JSON and may truncate it
according to `max_output_bytes`; large intermediate results may also be capped.
See the [data-flow trace](pipe-example-data-flow.md) for the path from request
to handler response.

### Filter empty grep-result lines

Split the string returned by `ctx.grep` into lines, then remove empty strings:

```json
{
  "expr": "const output = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); return output.split('\\n').filter(Boolean);"
}
```

For example, given this grep output (including a trailing newline):

```text
src/app.ts:3:TODO first

src/config.ts:8:TODO second
```

the pipe returns:

```json
["src/app.ts:3:TODO first", "src/config.ts:8:TODO second"]
```

This removes only empty strings, not whitespace-only lines or status messages.
An empty output string produces `[]`.

### Example 1 — grep for TODOs, return file:line pairs

Instead of calling `ashlr__grep` and getting back potentially thousands of lines, use `ashlr__pipe` to filter down to just the file:line pairs you care about:

For a step-by-step trace, see the [grep example walkthrough](pipe-grep-example-walkthrough.md).
For the string result and filtering behavior, see [grep example output](pipe-grep-example-output.md).

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const lines = raw.split('\\n').filter(Boolean).filter(l => l.includes(':')); return lines.slice(0, 20).map(l => l.split(':').slice(0,2).join(':'));"
}
```

`raw` is the text string returned by `ctx.grep`, not a collection of matches.
The expression creates `lines` by splitting that string on newline characters
with `raw.split('\n')`; the doubled backslash in the JSON example encodes the
single backslash in the JavaScript expression. `filter(Boolean)` removes empty
lines, including the empty entry produced by a trailing newline. The next filter
keeps only lines containing a colon, then the expression takes the first 20 and
joins each line's first two colon-separated fields.

For example, if `ctx.grep` returns:

```text
/project/src/app.ts:42:// TODO: validate input

/project/src/config.ts:7:// TODO: load defaults
```

the model receives a JSON array of strings, each containing the path and line
number joined by a colon (not an array of objects or two-element arrays):

```json
["/project/src/app.ts:42", "/project/src/config.ts:7"]
```

The array preserves the input order and contains at most the first 20 lines with a colon. If there are none, it is empty. This simple split assumes ripgrep-style `path:line:text` output and paths without colons; other grep output containing colons (such as genome results or status messages) can also appear in the array.

### Example 2 — grep for TODOs with an empty-result check

Example 1 keeps every line containing a colon, so a grep status line that
contains one — a confidence badge such as
`[ashlr confidence: low · bypassSummary:true to recover fidelity]`, an
`[embedding-cache hit | sim=0.953 | grep:TODO]` header, or another `status:`
message — can survive the filter and surface as a bogus `file:line` entry.
This variant keeps only lines in `path:line:` shape and checks for an empty
result explicitly:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const lines = raw.split('\\n').filter(l => /:\\d+:/.test(l)); if (lines.length === 0) return []; return lines.slice(0, 20).map(l => l.split(':').slice(0, 2).join(':'));"
}
```

The documented empty-result check is `if (lines.length === 0) return []`. The
`/:\d+:/` test requires digits between two colons — a line number — so blank
lines, the `[no matches]` sentinel, and status lines that contain colons but
no line number are all dropped before the check runs. An empty response, a
`[no matches]` response, or output made up only of status lines without that
shape therefore returns `[]` instead of a spurious `file:line` entry.

For an empty grep output string, the pipe returns:

```json
[]
```

An empty array means no lines passed this filter, not necessarily that the
search succeeded or found no matches. Inspect the original grep output when
search errors or completeness matter. The `:\d+:` test is a shape heuristic:
a status message containing that sequence can also pass it.

For example, if `ctx.grep` returns:

```text
/project/src/app.ts:42:// TODO: validate input
[ashlr confidence: low · bypassSummary:true to recover fidelity]
```

the badge line contains no `:\d+:` fragment and is filtered out, so the model
receives:

```json
["/project/src/app.ts:42"]
```

Like Example 1, the `split(':')` extraction assumes paths without colons and
emits at most 20 entries. Unlike a `^\S+`-anchored guard, `:\d+:` also
tolerates paths containing spaces.

### Example 3 — read several files and extract one fact each

Read the `name` field from every `package.json` found via `ctx.glob` (no shell required):

```json
{
  "expr": "const paths = (await ctx.glob({ pattern: '**/package.json', cwd: '.' })).split('\\n').filter(p => p && !p.includes('node_modules')).slice(0, 10); const names = []; for (const p of paths) { const content = await ctx.read({ path: p, bypassSummary: true }); try { const pkg = JSON.parse(content.split('\\n').slice(1).join('\\n')); if (pkg.name) names.push(pkg.name); } catch {} } return names;"
}
```

Intermediate file contents (potentially hundreds of KB) stay on the server. The model receives only the `["name-a", "name-b", ...]` array.

### Example 4 — shell access (requires `ASHLR_PIPE_ALLOW_BASH=1`)

`ctx.bash` is only available when the additional opt-in flag is set:

```sh
ASHLR_PIPE_ENABLE=1 ASHLR_PIPE_ALLOW_BASH=1 claude
```

```json
{
  "expr": "const listing = await ctx.bash({ command: 'find . -name package.json -not -path */node_modules/* -maxdepth 4' }); const paths = listing.split('\\n').filter(p => p.endsWith('package.json')); const names = []; for (const p of paths.slice(0, 10)) { const content = await ctx.read({ path: p, bypassSummary: true }); try { const pkg = JSON.parse(content.split('\\n').slice(1).join('\\n')); if (pkg.name) names.push(pkg.name); } catch {} } return names;"
}
```

Without the flag, `ctx.bash(...)` throws: `ctx.bash is disabled; set ASHLR_PIPE_ALLOW_BASH=1 to enable shell access in pipes`.

### Count nonempty grep-result lines

Count nonempty lines in the text returned by `ctx.grep`:

```json
{
  "expr": "const output = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); return output.split('\\n').filter(Boolean).length;"
}
```

For `src/app.ts:3:TODO first\nsrc/config.ts:8:TODO second\n`, the pipe
returns the JSON number `2`. Splitting at a trailing newline creates an empty
entry, which `filter(Boolean)` removes; an empty string returns `0`.

This counts all nonempty response lines, including whitespace-only lines and
status messages such as `[no matches]`. It is not necessarily a count of
matches or a complete project-wide total: grep output can include status or
error messages and intermediate results may be capped. For a match-shaped
filter, see [Count matching lines](#count-matching-lines).

### Show a fallback for an empty grep result

Return a clear message when grep returns an empty string or its bare
`[no matches]` marker; otherwise preserve its output:

```json
{
  "expr": "const output = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const text = output.trim(); return !text || text === '[no matches]' ? 'No TODOs found' : output;"
}
```

For a bare `[no matches]` response, the pipe returns:

```json
"No TODOs found"
```

Grep may attach status messages to its output. This example preserves those
responses (including an annotated no-match response) for inspection rather than
assuming they are empty; it does not guarantee a complete search result.

### Keep the grep response alongside file-and-line entries

To inspect status messages or errors as well as the extracted entries, return
the original response with the filtered list:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const matches = raw.split('\\n').map(line => line.match(/^(.+?):(\\d+):/)).filter(Boolean).slice(0, 20); return { files: matches.map(m => m[1] + ':' + m[2]), raw };"
}
```

For an empty response (`raw` is `""`), this returns:

```json
{"files": [], "raw": ""}
```

For a status-only response, `files` is empty when the status does not match the
`path:line:` shape, and `raw` retains the message. This shape is a heuristic:
a status line with the same shape can be mistaken for a match. A path containing
`:digits:` is also ambiguous. The list is limited to 20 entries; inspect `raw`
when search errors or completeness matter. Intermediate and final output caps
can truncate the response, so retaining `raw` does not guarantee completeness.

### Count matching lines

Count returned lines in `path:line:text` form whose text contains `TODO`:

```json
{
  "expr": "const output = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); return output.split('\\n').filter(line => /:\\d+:.*TODO/.test(line)).length;"
}
```

For this small grep output:

```text
src/app.ts:3:TODO first
src/app.ts:7:TODO second and TODO third
```

the pipe returns `2`: the second line is counted once even though it contains
two occurrences. For an empty output string or a `[no matches]` response, it
returns the JSON number `0`. The filter also excludes status lines that contain
`TODO` but lack a `:line:` field.

This is a count of returned lines passing a shape heuristic, not a guaranteed
project-wide total. A status line with the same `:digits:text` shape can still
be counted, grep can return other formats, and intermediate output may be
capped. A zero does not distinguish no matches from a search error or another
response without this shape; inspect the original output when completeness matters.

### Replace repeated matches in text

Use JavaScript's `replaceAll` to replace every occurrence in a string within
an expression. For example:

```json
{
  "expr": "return 'TODO first; TODO second; TODO'.replaceAll('TODO', 'DONE');"
}
```

The returned string is `DONE first; DONE second; DONE`. This transforms the
string in the pipe; it does not edit a file.

---

## Savings accounting

`ashlr__pipe` records **one** aggregate saving at the end:
- `rawBytes` = sum of all intermediate result lengths (what the model would have seen)
- `compactBytes` = final output length (what the model actually sees)

Intermediate calls are suppressed from the savings ledger so there is no double-counting.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `disallowed token "process"` | expr contains a blocked identifier | Rewrite without the blocked token |
| `expr exceeds 2000 characters` | Expression too long | Split into a shorter pipeline or use bash to do more work |
| `timed out after Nms` | Expression took longer than `timeout_ms` | Raise `timeout_ms` (max 30000) or simplify the pipeline |
| Tool count jumps by 1 | Flag was set during smoke test | Unset `ASHLR_PIPE_ENABLE` before running `bun run smoke:tools` |
| `ctx.bash is disabled` | `ASHLR_PIPE_ALLOW_BASH` not set | Set `ASHLR_PIPE_ALLOW_BASH=1` alongside `ASHLR_PIPE_ENABLE=1`, or rewrite expr using `ctx.glob`/`ctx.read` |
