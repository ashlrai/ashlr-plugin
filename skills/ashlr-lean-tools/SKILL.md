---
name: ashlr-lean-tools
description: Highest-impact token-saving habits for Claude Code tool use. Read-once, batch edits, orient-before-search, skip verification reads, grep-before-read, concise output at high spend. Reduces session token cost 30–60%.
---

# Ashlr Lean Tools

A discipline layer for tool use: each rule targets a specific token-waste pattern that commonly appears in long sessions.

## Rules (active when this skill is enabled)

### 1. Read-once
Do not re-read a file that is already in context. If you opened `src/auth.ts` earlier this session and haven't been told it changed, use the content you already have. Re-reads are the single largest source of avoidable input-token spend.

### 2. Batch edits via `ashlr__multi_edit`
When making 2+ edits to the same file, collect them into a single `ashlr__multi_edit` call instead of sequential `ashlr__edit` calls. Multi-edit applies all changes in one round-trip and returns a single compact diff.

### 3. Orient before searching
Run `ashlr__orient` once at the start of each task. The genome overview typically resolves "where does X live?" without any file reads. Skip orient only when continuing work in a file you already have open.

### 4. Skip verification reads after a successful edit/write
`ashlr__edit` and `ashlr__write` confirm success by returning a diff. Do not read the file again just to confirm the change landed — that's redundant and costs the full file content in tokens.

### 5. Grep-before-read
Before opening a file to find something, run `ashlr__grep` first. If the grep result shows the relevant lines, use them directly — no full file read needed.

### 6. Shift to concise output when session spend is high
When the session has accumulated >5,000 tokens of tool-call output, prefer shorter responses: skip preamble, use `file:line` citations instead of quoted blocks, and omit trailing summaries when the diff speaks for itself.

### 7. Prefer `ashlr__bash` over native `Bash` for verbose commands
`ashlr__bash` auto-compresses long stdout (test runners, git log, find, npm ls) — 60–90% token savings on large output.

## Anti-patterns

- Re-reading a file that hasn't changed since you last read it
- Two sequential `ashlr__edit` calls on the same file (use `ashlr__multi_edit`)
- Opening a file just to confirm an edit you just made
- Running `Read` before `Grep` to find a function
- Quoting large file contents in prose when a `file:line` reference suffices

## Activation

Enable via `/ashlr-lean-tools on` or by writing `{"enabled":true}` to `~/.ashlr/lean-tools.json`. Toggle off with `/ashlr-lean-tools off`.
