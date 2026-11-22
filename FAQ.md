# Frequently asked questions

<!-- fresh:begin install -->
```bash
npm install -g ashlr-plugin@1.38.7
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

### How does it fit the Ashlr ecosystem?

It is the efficiency layer. [Phantom](https://github.com/ashlrai/phantom) and its sibling repos (Phantom Secrets, Locus, Lexicon, Ashlr Stack, Ashlr MD) form an autonomous, code-first, agent-native software factory: agents do the engineering and maintain each repo, the human sits as a passive board member, and the goal is open source RSI (recursive self-improvement). `ashlr-plugin --ashlr-handshake` lets Phantom and other agents discover the plugin as JSON. The repo table is in [README.md](README.md#part-of-the-ashlr-ecosystem).

### How do I contribute with an agent?

Hand an issue to Claude Code, Codex, or another agent and let it follow [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md#from-branch-to-main): branch from `main`, run the checks, scan the diff for secrets, and open a PR. `CI Gate` is the single required check, and the PR lands through the merge queue once it is green. No write access? Use [Contribute from a fork with your own agent](CONTRIBUTING.md#contribute-from-a-fork-with-your-own-agent); a maintainer arms auto-merge for fork PRs. Start with the [good first issue](https://github.com/ashlrai/ashlr-plugin/labels/good%20first%20issue) label.
