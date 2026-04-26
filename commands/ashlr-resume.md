---
name: ashlr-resume
description: Resume your last coding session — shows what you were doing, which files were active, and suggested next steps.
argument-hint: "[<branch-name>]"
---

Show a compact summary of the most recent ashlr session so you can pick up
exactly where you left off.

## Usage

```
/ashlr-resume
/ashlr-resume <branch-name>
```

- **No argument** — summarizes the single most recent session regardless of branch.
- **With a branch name** — finds the most recent session whose timestamp overlaps
  commits on that branch (cross-references via `git log`), then labels the
  output with that branch.

## What it shows

```
Last session (yesterday, 2h ago — saved 4.3M tokens ≈$12.90):
  Branch:   feature/auth-flow
  Work dir: myapp  (12 reads, 4 edits)
            __tests__  (5 reads, 3 edits)
  Patterns: ashlr__grep ×7, Grep ×2
  Bash:     Bash ×18, ashlr__bash ×3
  Calls:    42 tool invocations

Resume? Suggested next steps based on the trail:
  - Re-open myapp (last edits in this session)
  - Re-run: Bash (used ×18 last session)
  - Continue on branch: feature/auth-flow
```

## Behavior

- Reads `~/.ashlr/session-log.jsonl` (active file) plus up to two rotated
  backups (`.jsonl.1`, `.jsonl.2`). Read-only — never modifies the log.
- If the log is missing or empty, prints "No prior sessions found — you're
  starting fresh."
- Token savings figures come from `session_end` events written at session close.
  If no `session_end` is present, tokens-saved shows as 0.

## Limitations

The session log records **tool names and working directories**, not individual
file paths or the content of grep patterns / bash commands. As a result:

- "Work dir" shows the repository directory rather than specific file paths.
- "Patterns" shows which grep tools were invoked (and how many times), not the
  actual search strings.
- "Bash" shows call counts for bash-family tools, not the specific commands run.

Individual argument capture is not part of the session-log schema (v1) by design
— arguments may contain secrets. A future schema version may add opt-in argument
hinting.

## Implementation

```sh
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/session-resume.ts [<branch>]
```

Print the script's stdout verbatim. The output is designed to be read directly;
do not paraphrase or reformat it.

If the script fails, fall back to:
`/ashlr-resume failed — check ~/.ashlr/session-log.jsonl exists and is readable.`
