---
name: ashlr-efficient
description: Output structure reshaper for Claude Code. Complements ashlr-brief's prose trimming by enforcing inverted-pyramid order, inline code for identifiers, tables for multi-item comparisons, and no transitional filler. Works standalone or alongside ashlr-brief.
---

# Ashlr Efficient

Reshapes the **structure** of responses — not just their wordiness. Works independently of `ashlr-brief` (which trims prose volume). When both are active, both rulesets apply simultaneously.

## Rules (active when this skill is enabled)

### 1. Inverted pyramid — answer first
Lead with the answer or conclusion. Context and explanation follow. Never open with background before the answer.

**Before:** "In order to understand why this matters, we need to look at how auth works in this codebase. The token is validated in middleware..."
**After:** "The `verifyToken` middleware at `src/auth.ts:42` is the validation point. It checks..."

### 2. Inline code for all identifiers and paths
Any function name, variable, type, file path, CLI command, or config key appears in backtick inline code — never in plain prose.

**Before:** "The handleAuth function in the auth file calls verifyToken."
**After:** "`handleAuth` in `src/auth.ts` calls `verifyToken`."

### 3. Tables for 3+ item comparisons
When comparing 3 or more options, tools, config values, or behaviors — use a markdown table, not a bulleted prose list.

**Before:**
- `ashlr__edit` is for single edits
- `ashlr__multi_edit` is for multiple edits to one file
- `ashlr__edit_structural` is for renames

**After:**
| Tool | Use case |
|---|---|
| `ashlr__edit` | Single search/replace |
| `ashlr__multi_edit` | Multiple edits, one file |
| `ashlr__edit_structural` | Symbol/file renames |

### 4. No transitional filler
Drop: "Now that we've seen X, let's look at Y", "As mentioned above", "Moving on to", "Let's now", "With that in mind", "That said". Just move to the next point.

### 5. `file:line` citations instead of quoted blocks
When pointing to code, use `path/to/file.ts:42` format. Only quote the exact lines when they are load-bearing to the explanation (e.g., a bug pattern, a function signature the user asked for).

## Auto-clarity exceptions (full structure restored)

These contexts always get full explanatory structure regardless of the efficient level:
- Destructive actions (`rm -rf`, `git reset --hard`, force-push, `DROP TABLE`)
- Security findings (credentials, secrets, vulnerabilities)
- Error messages and stack traces (rendered verbatim)
- Multi-step migrations where sequence matters
- Code blocks and diffs (pass through untouched)

## When both `ashlr-brief` and `ashlr-efficient` are active

Both rulesets apply simultaneously:
- `ashlr-brief` reduces prose volume (drops filler words, padding)
- `ashlr-efficient` reshapes structure (answer-first, tables, inline code, no filler transitions)

The combined effect is maximum output efficiency without sacrificing correctness or readability.

## Activation

Enable via `/ashlr-efficient on` or by writing `{"enabled":true}` to `~/.ashlr/efficient.json`. Toggle off with `/ashlr-efficient off`.
