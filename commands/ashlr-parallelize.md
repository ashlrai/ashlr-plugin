---
name: ashlr-parallelize
description: Spawn N parallel sub-agents — one per file — each applying the same task instruction. Merges results into a unified report.
argument-hint: "`<task>` `<file1>` [file2] [file3] ... [--code]"
---

Spawn one sub-agent per file, all running the same task in parallel, then merge their outputs.

## Usage

```
/ashlr-parallelize <task> <file1> [file2] [file3] ... [--code]
```

- `<task>` — the instruction to apply to each file (quoted string or unquoted phrase ending before the first file path).
- `<file1> [file2] ...` — one or more file paths (contain `/` or `.` or start with `__`).
- `--code` — optional flag. When present, use `ashlr:ashlr:code` (sonnet) agents instead of the default `ashlr:ashlr:explore` (haiku) agents. Use `--code` when the task requires edits; omit for read-only analysis.

## Examples

```
/ashlr-parallelize "explain what this module exports" src/utils.ts src/helpers.ts src/types.ts
/ashlr-parallelize "find all TODO comments and summarize them" hooks/pretooluse-read.ts hooks/pretooluse-bash.ts
/ashlr-parallelize --code "add JSDoc to all exported functions" servers/read-server.ts servers/grep-server.ts
```

## Steps

1. Parse `$ARGUMENTS`:
   - Detect `--code` flag (remove from argument list before further parsing).
   - Determine `subagent_type`: `ashlr:ashlr:code` if `--code`, else `ashlr:ashlr:explore`.
   - Split remaining tokens: file-path-like tokens (contain `/`, `.`, or start with `__`) → file list; everything before the first file path → task string.
   - If no files are found, error: "No files specified. Usage: /ashlr-parallelize `<task>` `<file1>` [file2] ..."
   - If task string is empty, error: "No task specified. Usage: /ashlr-parallelize `<task>` `<file1>` [file2] ..."

2. For each file, construct an agent prompt:
   ```
   Task: <task>

   File: <file_path>

   Focus exclusively on this file. Do not read other files unless they are direct imports needed to answer the task. Keep your response under 300 words. Cite file:line for every claim.
   ```

3. Spawn all agents in parallel via the Agent tool — one per file — each with `subagent_type` as determined in step 1.

4. Wait for all agents to complete.

5. Print merged report:
   ```
   ## /ashlr-parallelize — <N> agents · task: <task>

   ### <file1>
   <agent 1 output>

   ### <file2>
   <agent 2 output>

   ---
   Agents: <N> · subagent_type: <type> · files: <list>
   ```

Reuses agent definitions from `agents/ashlr-explore.md` (default) and `agents/ashlr-code.md` (--code).
