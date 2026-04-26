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

If `$ARGUMENTS` contains `--context`, also run:

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/context-status.ts"
```

If `ASHLR_CONTEXT_DB_DISABLE=1` is set, print `ashlr context-db: disabled (ASHLR_CONTEXT_DB_DISABLE=1)` instead. Append the output under a `## Embedding cache` section after the main status block.

If `$ARGUMENTS` contains `--telemetry` (or is not set — always include this section), append a **Telemetry snapshot** section:

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-status.ts"
```

This reports:
- **LLM provider** — which provider `selectProvider()` would pick right now (anthropic / onnx / local / snipCompact-only). Determined by: `ANTHROPIC_API_KEY` set? → anthropic. ONNX runtime available? → onnx. Else → local or snipCompact.
- **Embedding cache** — total embeddings in `~/.ashlr/context.db`, hit rate over last 100 calls from `~/.ashlr/embed-calibration.jsonl`.
- **Genome** — sections present (count files in `.ashlrcode/genome/`), fire-rate (fraction of last 50 `ashlr__grep` calls where `genome_route_taken` was emitted, from `~/.ashlr/session-log.jsonl`).
- **Block→ashlr ratio (24h)** — blocks emitted vs `tool_called_after_block` events in last 24h from hook-timings.jsonl + session-log.jsonl. Shows conversion rate as %.
- **Opt-in telemetry** — current mode (off / opt-in) + buffer line count + how to disable.

Format:

```
## Telemetry snapshot
  llm-provider:   anthropic (ANTHROPIC_API_KEY set)
  embed-cache:    847 entries · last-100 hit rate 34%
  genome:         12 sections · last-50 grep fire-rate 68%
  block→ashlr:    42 blocks / 31 converted = 74% (24h)
  opt-in telemetry: OFF (default) · to enable: ASHLR_TELEMETRY=on
```

When telemetry is ON, show instead:

```
  opt-in telemetry: ON · buffer: 42 events · to disable: ASHLR_TELEMETRY=off
```

If any data is unavailable (file absent, DB not initialized), show `—` for that field rather than erroring.

No preamble, no trailing summary.
