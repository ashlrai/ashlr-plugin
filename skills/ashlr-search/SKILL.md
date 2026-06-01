---
name: ashlr-search
description: Genome-aware search habits for Claude Code. Prefer ashlr__grep and ashlr__glob over native scans; compose multi-term queries; trust genome summaries; orient once before searching. Reduces redundant reads and search token cost 40–70%.
---

# Ashlr Search

Shift every search operation to the genome-aware layer so redundant file reads are eliminated before they happen.

## Core rules (active when this skill is enabled)

1. **Orient first.** Run `ashlr__orient` once at the start of each task — before any grep or glob. The genome overview often answers the "where does X live?" question without a single file read.

2. **Prefer `ashlr__grep` over native `Grep`.** `ashlr__grep` is genome-aware: when a `.ashlrcode/genome/` directory exists it returns pre-summarized relevant sections instead of raw ripgrep output. The token cost is 70–90% lower on large repos.

3. **Prefer `ashlr__glob` over native `Glob`.** Same reason — genome-aware glob filters to relevant paths and avoids returning thousands of lines for broad patterns.

4. **Compose multi-term queries with `|` alternation.** A single call `ashlr__grep("auth|session|token")` is cheaper than three sequential calls. Combine related terms whenever the goal is "find anything touching X".

5. **Trust genome section summaries.** When `ashlr__grep` returns a genome section match with a summary, read the summary — do NOT immediately open the referenced file unless you need exact line content for an edit. Genome summaries are curated; they reflect what actually matters in that section.

6. **Do not re-search what's already in context.** If a previous tool call already returned content for a file or pattern, use that result. Re-running the same grep costs tokens and returns nothing new.

## Anti-patterns

- Running native `Grep` when `ashlr__grep` is available
- Running 3+ sequential single-term greps instead of one combined query
- Reading a full file after a genome summary already answered the question
- Globbing broad patterns (`**/*.ts`) without first checking the genome manifest

## Example

```
# Good: orient first, then one composed grep
ashlr__orient()
ashlr__grep("authMiddleware|verifyToken|session.userId")

# Bad: three native greps, no orient
Grep("authMiddleware")
Grep("verifyToken")
Grep("session.userId")
```

## Activation

Enable via `/ashlr-search on` or by writing `{"enabled":true}` to `~/.ashlr/search.json`. Toggle off with `/ashlr-search off`.
