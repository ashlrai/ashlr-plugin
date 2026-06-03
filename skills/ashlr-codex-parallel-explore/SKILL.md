---
name: ashlr-codex-parallel-explore
description: Efficient parallel exploration habits for Codex. Use when a task needs several independent codebase questions answered before implementation.
---

# Ashlr Codex Parallel Explore

For multi-file work, split exploration into independent questions:

- One explorer maps ownership, entrypoints, and existing patterns.
- Another explorer audits risks, tests, and edge cases.
- Keep implementation local unless a worker can own a disjoint file set.

Use Ashlr tools in each exploration:

```sh
ashlr codex-start --json
```

Then prefer `ashlr__orient`, `ashlr__grep`, `ashlr__tree`, and `ashlr__read` before opening raw files.
