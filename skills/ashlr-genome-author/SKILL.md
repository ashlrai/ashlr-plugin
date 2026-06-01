---
name: ashlr-genome-author
description: Guidelines for when and how to call ashlr__genome_propose to keep the project genome accurate. Covers post-architectural-decision proposals, correct summary format, and what NOT to propose. Keeps the genome signal-rich without noise.
---

# Ashlr Genome Author

The genome is the project's living architectural memory. `ashlr__genome_propose` adds new knowledge to it. This skill governs when and how to call it so the genome stays signal-rich.

## When to call `ashlr__genome_propose`

Call it after:

- **A new module is added** — new file(s) that introduce a concept, service, or subsystem not previously in the genome.
- **A schema change** — database table added/dropped/migrated, or a core TypeScript interface redefined.
- **An auth or security change** — new middleware, permission model, token strategy, or RLS policy.
- **A routing change** — new API endpoint, route group, or server registered.
- **An architectural decision** — choosing a pattern, library, or data model that future contributors need to understand.

## Summary format

Write a **2–5 sentence past-tense summary** that describes:
1. What was changed or added.
2. Why (the intent or problem it solves).
3. Where: end with the relevant file paths.

Example:
> "Added `hooks/stop-accounting.ts` to finalize session stats on the Stop event. This complements the existing SessionEnd GC path with an idempotency guard so duplicate entries are never written. Files: `hooks/stop-accounting.ts`, `hooks/hooks.json`."

## When NOT to call `ashlr__genome_propose`

- Routine edits (bug fixes, typo corrections, test updates) that don't change the architecture.
- Edits to files already well-described in the genome with no structural change.
- Mid-task (wait until the change is complete and stable).
- More than once per logical change — one proposal per architectural event.

## Section names

Use existing manifest section names when the change belongs to an existing area. Only introduce a new section name when the change is genuinely a new architectural concept.

## Activation

Enable via `/ashlr-genome-author on` or by writing `{"enabled":true}` to `~/.ashlr/genome-author.json`. Toggle off with `/ashlr-genome-author off`.
