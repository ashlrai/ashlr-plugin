# X / Twitter launch post — v1.36 Codex-native release

## Main thread

**1/**
Codex and Claude Code sessions burn tokens on file I/O: full reads, full grep output, verbose shell logs, and before/after edit payloads.

ashlr is an open-source efficiency layer that compresses those workflows instead of shipping the whole payload every time.

**Measured cross-repo savings: −57%.**

---

**2/**
v1.36 ships:

- 40 MCP tools
- Codex plugin manifest in `.codex-plugin/`
- Codex MCP config in `.mcp.json`
- Codex workflow skills
- Codex nudge-first hooks
- Claude Code slash commands, redirects, and status line
- Cursor and Goose MCP ports

---

**3/**
The benchmark is reproducible:

- TypeScript (`vercel/ai`): −62%
- Python (`pandas`): −65%
- Rust (`tokio`): −44%
- Cross-language mean: −57%

Methodology is public in `docs/benchmarks.md`.

---

**4/**
The free tier is not crippled.

MIT license. No account required. Telemetry off by default. Stats stay local unless you explicitly enable hosted features.

Pro adds cloud genome sync and hosted summarization; the 40 MCP tools remain free.

---

**5/**
Install:

```sh
git clone https://github.com/ashlrai/ashlr-plugin
cd ashlr-plugin && bun install
codex plugin marketplace add ashlrai/ashlr-plugin
codex plugin add ashlr@ashlr-marketplace
bun run scripts/cli.ts codex-doctor --json
```

Claude Code users can run the installer, then the marketplace slash commands.

plugin.ashlr.ai

## Standalone single post

Open-source Codex + Claude Code efficiency layer: 40 MCP tools, Codex skills, nudge-first Codex hooks, Claude Code slash commands/status line, and measured −57% cross-repo token savings. MIT, no account required, telemetry off by default. plugin.ashlr.ai
