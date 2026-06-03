---
name: ashlr-codex-savings
description: Inspect Ashlr token savings from Codex using host-neutral CLI and MCP surfaces.
---

# Ashlr Codex Savings

Use either surface:

```sh
ashlr stats --json
ashlr tools --json
```

When the MCP server is available, call `ashlr__savings` for an in-session summary.

Stats are written after tool calls, not during MCP registration. If there are no stats yet, run one Ashlr MCP tool first.
