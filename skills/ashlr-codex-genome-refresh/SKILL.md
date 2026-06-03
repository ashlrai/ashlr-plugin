---
name: ashlr-codex-genome-refresh
description: Refresh or maintain Ashlr project genome state from Codex. Use after architectural changes, schema/routing changes, or substantial refactors.
---

# Ashlr Codex Genome Refresh

After meaningful architecture changes, refresh project memory:

```sh
ashlr genome-refresh --json
```

When an MCP genome tool is available, prefer the direct tool:

- `ashlr__genome_status` to inspect current genome state
- `ashlr__genome_propose` for a concise update proposal
- `ashlr__genome_consolidate` after reviewing pending proposals

Do not propose routine typo fixes or test-only changes. One proposal per logical architectural change is enough.
