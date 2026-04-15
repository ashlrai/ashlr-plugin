---
name: ashlr-status
description: Report the ashlr-plugin activation status and MCP server health.
---

Report the following as a compact status block:

1. **Plugin version** — from `.claude-plugin/plugin.json`
2. **MCP server reachable** — call `ashlr__savings` and see if it returns; if yes, mark green
3. **Genome detected** — check for `.ashlrcode/genome/` in `process.cwd()`; report yes/no
4. **Core library version** — read `~/Desktop/ashlr-core-efficiency/package.json` if accessible
5. **Session savings** — from `ashlr__savings`

Format:

```
ashlr-plugin v0.1.0
  server:  ✓ reachable
  genome:  ✓ (.ashlrcode/genome found) | ✗ (no genome — run `/genome init`)
  core:    @ashlr/core-efficiency@0.1.0
  session: 12 calls, ~8,450 tokens saved
```

No preamble, no trailing summary.
