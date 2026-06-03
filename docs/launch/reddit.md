# Reddit launch posts — v1.36 Codex-native release

## r/codex or r/ClaudeCode title

**ashlr v1.36 — open-source Codex + Claude Code efficiency layer, 40 MCP tools, −57% measured token savings**

## Body

I shipped the Codex-native Ashlr release.

Ashlr is an open-source MCP/plugin layer that reduces token waste from high-volume AI coding workflows: file reads, grep output, shell logs, edit summaries, directory trees, diffs, SQL output, HTTP fetches, GitHub PR/issue reads, and project memory retrieval.

What ships now:

- 40 MCP tools
- Codex plugin manifest in `.codex-plugin/`
- Codex MCP config in `.mcp.json`
- Codex workflow skills and explorer/worker guidance
- Codex nudge-first hooks
- Claude Code slash commands, status line, and redirect hooks
- Cursor and Goose MCP ports

The benchmark is reproducible and uses TypeScript, Python, and Rust reference repos:

- TypeScript (`vercel/ai`): −62%
- Python (`pandas`): −65%
- Rust (`tokio`): −44%
- Cross-language mean: −57%

Install:

```sh
git clone https://github.com/ashlrai/ashlr-plugin
cd ashlr-plugin && bun install
codex plugin marketplace add ashlrai/ashlr-plugin
codex plugin add ashlr@ashlr-marketplace
bun run scripts/cli.ts codex-doctor --json
```

Claude Code users can run the installer, then the marketplace slash commands.

MIT, no account required, telemetry off by default. Pro adds hosted infrastructure; the local MCP tool surface remains free.

Landing: https://plugin.ashlr.ai/
Repo: https://github.com/ashlrai/ashlr-plugin
