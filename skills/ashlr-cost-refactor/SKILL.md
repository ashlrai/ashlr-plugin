---
name: ashlr-cost-refactor
description: Token-efficient refactoring discipline for Claude Code. Diff-first before editing, structural edits for renames, find-all-refs then one multi_edit per file, no re-reads between edits, one genome proposal at the end. Reduces refactor session cost 40–65%.
---

# Ashlr Cost Refactor

A structured discipline for refactoring tasks that minimizes token spend without sacrificing correctness.

## Rules (active when this skill is enabled)

### 1. Diff first
Before editing anything, run `ashlr__diff` or `ashlr__diff_semantic` to understand what already changed (staged/unstaged). This prevents redundant edits to files that are already in the state you want.

### 2. Structural edits for renames
When renaming a symbol, type, or file — use `ashlr__edit_structural` instead of search/replace. Structural edit finds all references in one pass and renames them correctly, including imports and re-exports.

### 3. Find all refs, then one `ashlr__multi_edit` per file
Before editing a file, run `ashlr__grep` to find all references. Then apply all changes to that file in a single `ashlr__multi_edit` call. Do not make sequential single edits to the same file — each one burns a full round-trip.

### 4. No re-reads between edits in a sequence
Once you've read a file and know its structure, proceed through your edit sequence without re-reading. `ashlr__edit` and `ashlr__multi_edit` return diffs that confirm each change — that's sufficient to continue.

### 5. One `ashlr__genome_propose` at the end
After the refactor is complete and stable, write one genome proposal summarizing the entire change: what was renamed/moved, why, and the affected file paths. Do not propose mid-refactor.

### 6. Verify with `ashlr__bash` not `Read`
After a refactor, confirm with `bun run typecheck` or `bun test` via `ashlr__bash`. Do not re-read edited files to verify — the typecheck output is authoritative and far cheaper.

## Sequence template

```
1. ashlr__diff_semantic()             — see what's already changed
2. ashlr__grep("OldName|oldFn")       — find all refs
3. ashlr__edit_structural(...)        — rename symbols
   OR ashlr__multi_edit([...])        — batch all edits per file
4. ashlr__bash("bun run typecheck")   — verify, not Read
5. ashlr__genome_propose(summary)     — one proposal at the end
```

## Anti-patterns

- Running `Read` before each edit in a multi-file refactor
- Making 3 sequential `ashlr__edit` calls on the same file
- Re-reading a file after editing it to confirm the change
- Calling `ashlr__genome_propose` after each individual edit

## Activation

Enable via `/ashlr-cost-refactor on` or by writing `{"enabled":true}` to `~/.ashlr/cost-refactor.json`. Toggle off with `/ashlr-cost-refactor off`.
