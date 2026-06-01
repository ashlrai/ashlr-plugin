---
name: ashlr-pipe
description: Run a multi-step JS expression that calls grep/read/bash/ls/glob internally — intermediate results never enter context, only the return value does.
---

## Overview

`ashlr__pipe` lets you run a JavaScript async expression that orchestrates multiple ashlr tool calls in a single round-trip. Intermediate results (grep output, file contents, bash stdout) are computed server-side and **never sent to the model context** — only the expression's final return value does. Typical savings: **80–95%** vs calling the same tools individually.

### When to use it

- You need to grep for a pattern, then filter/transform the results
- You need to read several files and extract one fact from each
- You need to bash-query something and do arithmetic on the result
- Any pipeline where you'd otherwise burn context on large intermediate strings

### Rollout flag

`ashlr__pipe` is **disabled by default** in v1.34. Enable it per-session:

```sh
ASHLR_PIPE_ENABLE=1 claude
```

Or add it to your project's MCP environment config to enable permanently.

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

| Method | Equivalent tool | Args |
|---|---|---|
| `ctx.grep(args)` | `ashlr__grep` | `{ pattern, cwd?, bypassSummary?, ... }` |
| `ctx.read(args)` | `ashlr__read` | `{ path, bypassSummary? }` |
| `ctx.bash(args)` | `ashlr__bash` | `{ command, cwd?, timeout_ms? }` |
| `ctx.ls(args)` | `ashlr__ls` | `{ path? }` |
| `ctx.glob(args)` | `ashlr__glob` | `{ pattern, cwd? }` |

Each method returns the tool's text output as a plain string.

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

### Example 1 — grep for TODOs, return file:line pairs

Instead of calling `ashlr__grep` and getting back potentially thousands of lines, use `ashlr__pipe` to filter down to just the file:line pairs you care about:

```json
{
  "expr": "const raw = await ctx.grep({ pattern: 'TODO', cwd: '.', bypassSummary: true }); const lines = raw.split('\\n').filter(l => l.includes(':')); return lines.slice(0, 20).map(l => l.split(':').slice(0,2).join(':'));"
}
```

The model receives a compact JSON array of `["file.ts:42", ...]` — not the full grep output.

### Example 2 — read several files and extract one fact each

Read the first line of every `package.json` in a monorepo and return just the `name` field:

```json
{
  "expr": "const listing = await ctx.bash({ command: 'find . -name package.json -not -path */node_modules/* -maxdepth 4' }); const paths = listing.split('\\n').filter(p => p.endsWith('package.json')); const names = []; for (const p of paths.slice(0, 10)) { const content = await ctx.read({ path: p, bypassSummary: true }); try { const pkg = JSON.parse(content.split('\\n').slice(1).join('\\n')); if (pkg.name) names.push(pkg.name); } catch {} } return names;"
}
```

Intermediate file contents (potentially hundreds of KB) stay on the server. The model receives only the `["name-a", "name-b", ...]` array.

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
