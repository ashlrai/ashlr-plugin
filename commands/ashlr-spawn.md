---
name: ashlr-spawn
description: Spawn a named delegation pattern as one or more sub-agents. Patterns defined in _spawn-patterns.json.
argument-hint: "<pattern> [args...]"
---

Spawn a named delegation pattern using `_spawn-patterns.json`.

## Patterns available

- `triage-issues` — classify open issues by severity / label / age (haiku, batch)
- `refactor-files` — apply a described refactor across a file list (sonnet, parallel-per-file)
- `codebase-explain` — explain a codebase area with key files + flow (haiku, tiered)
- `pr-review-sweep` — review all changed files in a PR (sonnet, parallel-per-file-changed)
- `parallel-test-fix` — fix failing tests across multiple files (sonnet, parallel-per-file)

## Argument convention

```
/ashlr-spawn <pattern> [args...]
```

- First positional token after `/ashlr-spawn` is the **pattern name**.
- Everything after the pattern name is the **args** string, passed verbatim to the prompt template as `{{args}}`.
- For file-fanout patterns (`refactor-files`, `parallel-test-fix`), additional tokens that look like file paths (contain `/` or `.`) are collected into `{{files}}`; the remaining tokens form `{{args}}`.

Examples:
```
/ashlr-spawn triage-issues
/ashlr-spawn codebase-explain the genome pipeline
/ashlr-spawn refactor-files extract pure functions src/utils.ts src/helpers.ts
/ashlr-spawn pr-review-sweep 123
/ashlr-spawn parallel-test-fix __tests__/savings-math.test.ts __tests__/stats-sqlite.test.ts
```

## Steps

1. Parse `$ARGUMENTS`:
   - Extract the pattern name (first token).
   - Collect remaining tokens: file-path-like tokens → `{{files}}`; everything else → `{{args}}`.

2. Read `commands/_spawn-patterns.json` (path: `${CLAUDE_PLUGIN_ROOT}/commands/_spawn-patterns.json`). If the file is missing, error: "\_spawn-patterns.json not found — run from the plugin root."

3. Look up the pattern. If not found, print: "Unknown pattern '<name>'. Available: triage-issues, refactor-files, codebase-explain, pr-review-sweep, parallel-test-fix" and stop.

4. Render the `prompt_template` by substituting `{{args}}` and `{{files}}` with the parsed values (empty string if not provided).

5. Apply `fanout_strategy`:
   - `batch` — spawn **one** Agent with `subagent_type` from the pattern, passing the rendered prompt.
   - `parallel-per-file` — spawn **one Agent per file** in `{{files}}`, each with the same rendered prompt focused on that single file. Collect results.
   - `parallel-per-file-changed` — use `git diff --name-only origin/main...HEAD` to get the changed file list, then spawn one Agent per file.
   - `tiered` — spawn Phase 1 `ashlr:ashlr:explore` agent, then pass its output to Phase 2 `ashlr:ashlr:code` agent for deeper analysis.

6. Wait for all agents to complete.

7. Print a merged report:
   - Header: `## /ashlr-spawn <pattern> — <N> agent(s) completed`
   - One section per agent output (for multi-agent fanouts, titled by file name).
   - Footer: total agents spawned, pattern used, fanout strategy.

If `$ARGUMENTS` is empty, print the patterns list and stop.
