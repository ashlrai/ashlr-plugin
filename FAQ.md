# Frequently asked questions

<!-- fresh:begin install -->
```bash
npm install -g ashlr-plugin@1.37.1
```
<!-- fresh:end -->

Short answers for agents and humans. Runnable commands live in [llms-full.txt](llms-full.txt) and [README.md](README.md).

### What is this?

An open source efficiency layer for coding agents. It exposes shorter file, search, edit, and shell tools over MCP, plus a CLI that prints JSON.

### How does an agent install it?

```bash
npm install -g ashlr-plugin
ashlr-plugin --ashlr-handshake
ashlr-plugin tools --json
ashlr-plugin stats --json
```

Then register `ashlr-mcp` for Claude Code, Cursor, or Codex. The snippets are in [llms-full.txt](llms-full.txt). No account required.

### Does it send my code anywhere?

Not by default. The server runs locally. Telemetry is off unless you set `ASHLR_TELEMETRY=on`. The contract is [docs/telemetry.md](docs/telemetry.md).

### What does a savings figure mean?

A per-call difference, not a whole session. The 2026-10-17 reference run is in [docs/benchmarks.md](docs/benchmarks.md). Your ledger is `ashlr-plugin stats --json`.

### Which hosts are supported?

Claude Code (plugin, hooks, slash commands, status line), Codex (plugin, skills, nudge hooks, CLI), Cursor (MCP), Goose, and any host that can start `ashlr-mcp`. See [docs/multi-host-mcp.md](docs/multi-host-mcp.md).

### What is the free tier?

The local plugin, including the MCP tools and the CLI. Pro and Team add hosted features. Prices are in [docs/pricing.md](docs/pricing.md).
