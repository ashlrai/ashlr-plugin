---
name: ashlr-context-status
description: Show embedding cache stats — total embeddings, projects tracked, db size, and hit rate.
---

Run `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/context-status.ts` and display the output verbatim.

If `ASHLR_CONTEXT_DB_DISABLE=1` is set, print:

```
ashlr context-db: disabled (ASHLR_CONTEXT_DB_DISABLE=1)
```

No preamble, no trailing summary.
