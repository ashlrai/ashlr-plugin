# ashlr-plugin

Open-source Claude Code plugin that **cuts token usage** via genome-aware file retrieval, 3-tier context compression, and provider-aware prompt budgeting. Alternative to [WOZCODE](https://wozcode.com), powered by [`@ashlr/core-efficiency`](../ashlr-core-efficiency).

## What it does

Replaces Claude Code's built-in file tools (Read/Grep) with optimized MCP tools that return **fewer tokens per call** while preserving the information the agent actually needs:

| Tool | Mechanism | Typical saving |
|------|-----------|----------------|
| `ashlr__read` | Snips tool-result blobs > 2000 chars using `snipCompact` from `@ashlr/core-efficiency/compression` | 30–70% on large files |
| `ashlr__grep` | Genome-aware relevance filtering via `retrieveSectionsV2` when a `.ashlrcode/genome/` directory is present; falls back to plain grep | 40–80% on projects with a genome |
| `ashlr__edit` | Token-efficient diff format instead of full before/after | 20–50% on structured edits |

Plus three agents that mirror the WOZCODE tri-agent pattern:

| Agent | Model | Role |
|-------|-------|------|
| `ashlr:code` | sonnet | Main coding agent. Delegates when appropriate. |
| `ashlr:explore` | haiku | Read-only codebase exploration (cheap, fast). |
| `ashlr:plan` | haiku | Architecture + implementation planning (cheap, fast). |

## Install

```
/plugin marketplace add masonwyatt23/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

Restart Claude Code. Look for **`ashlr:code`** on the right side of the input field.

## Commands

| Command | Description |
|---------|-------------|
| `/ashlr-savings` | Show estimated token & cost saved this session and lifetime |
| `/ashlr-settings` | View or change plugin settings |
| `/ashlr-status` | Plugin status + MCP server health |

## How the efficiency tech works

All three optimizations live in the shared `@ashlr/core-efficiency` library, which is also used by Mason's standalone CLI [`ashlrcode`](../ashlrcode). One implementation, two consumers.

- **Genome RAG** — `.ashlrcode/genome/` stores a sectioned, evolving project spec. Instead of dumping full files into context, the plugin retrieves only task-relevant sections via TF-IDF or Ollama-powered semantic search.
- **3-tier compression** — `autoCompact` (LLM summarize old turns) → `snipCompact` (truncate tool results > 2KB) → `contextCollapse` (drop short/duplicate messages).
- **Provider-aware budget** — system prompt = 5% of the provider's context limit, capped at 50K. Anthropic 200K → 10K budget; xAI 2M → 50K budget.

See [`../ashlr-core-efficiency`](../ashlr-core-efficiency) for the library internals.

## Status

**v0.1.0 scaffold.** Directory structure, manifests, agent definitions, MCP server scaffold, and slash commands are in place. The MCP server's `ashlr__read` / `ashlr__grep` / `ashlr__edit` tools are functional stubs; they wire through `@ashlr/core-efficiency` primitives but are not yet benchmarked against WOZCODE.

Roadmap before v1.0:
- [ ] Benchmark suite comparing tokens-per-task vs Claude Code defaults and WOZCODE
- [ ] Savings tracker persistence (`~/.ashlr/stats.json`)
- [ ] Hook: on session-start, announce plugin activation + savings
- [ ] Auto-delegation hints in `ashlr:code` prompt so it correctly offloads to `ashlr:explore` / `ashlr:plan`
- [ ] Publish to npm and register with Claude Code marketplace

## License

MIT — [LICENSE](./LICENSE).
