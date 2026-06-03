# Hacker News launch post — v1.36 Codex-native release

## Title options

- Show HN: Ashlr — open-source Codex and Claude Code plugin, −57% tokens
- Show HN: Ashlr — token-efficient MCP tools for Codex and Claude Code
- Show HN: 40 MCP tools that compress AI coding context

## URL

https://plugin.ashlr.ai/

## First comment

Hi HN. I built Ashlr after watching AI coding sessions spend a lot of context on file I/O the model did not actually need: full file reads, full grep output, verbose shell logs, and edit payloads that echo too much surrounding state.

Ashlr is an open-source MCP/plugin layer for Codex, Claude Code, Cursor, Goose, and generic MCP hosts. It ships 40 MCP tools. The high-volume ones are lower-token alternatives for read, grep, edit, bash, tree, logs, diff, SQL, HTTP, GitHub PR/issue reads, and project genome retrieval.

The current release is Codex-native:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- Codex workflow skills
- Codex explorer/worker guidance
- nudge-first Codex hooks

Claude Code remains supported with slash commands, status line, and redirect-mode hooks. Cursor and Goose use the MCP server directly.

The benchmark headline is −57% cross-repo token savings:

- TypeScript (`vercel/ai`): −62%
- Python (`pandas`): −65%
- Rust (`tokio`): −44%

The methodology is public in `docs/benchmarks.md`; the benchmark runner is in `scripts/run-benchmark.ts`.

Ethics/ops: MIT license, no account required, telemetry off by default, no code/path/prompt telemetry in the default setup. Pro features are hosted genome sync and hosted summarization; the local MCP tool surface remains free.

Install:

```sh
git clone https://github.com/ashlrai/ashlr-plugin
cd ashlr-plugin && bun install
codex plugin marketplace add ashlrai/ashlr-plugin
codex plugin add ashlr@ashlr-marketplace
bun run scripts/cli.ts codex-doctor --json
```

Repo: https://github.com/ashlrai/ashlr-plugin
