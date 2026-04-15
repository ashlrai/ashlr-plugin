# ashlr-plugin

[![landing page](./docs/assets/og.png)](https://plugin.ashlr.ai/)

**Landing page:** [plugin.ashlr.ai](https://plugin.ashlr.ai/) · **Core library:** [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency) · **License:** MIT

Open-source Claude Code plugin that **cuts token usage** via genome-aware file retrieval, 3-tier context compression, and provider-aware prompt budgeting. Alternative to [WOZCODE](https://wozcode.com). Mean **−79.5%** savings on files ≥ 2 KB ([benchmarks](./docs/benchmarks.json)).

## What it does

Replaces Claude Code's built-in file/shell/SQL workflows with optimized MCP tools that return **fewer tokens per call** while preserving the information the agent actually needs:

| Tool | Mechanism | Typical saving |
|------|-----------|----------------|
| `ashlr__read` | Snips tool-result blobs > 2000 chars using `snipCompact` | **−79.5%** on files ≥ 2 KB ([benchmarks](./docs/benchmarks.json)) |
| `ashlr__grep` | Genome-aware relevance filtering when `.ashlrcode/genome/` exists; ripgrep fallback | 40–80% on projects with a genome |
| `ashlr__edit` | In-place search/replace with diff summary only; strict-by-default for safety | 20–50% on structured edits |
| `ashlr__sql` | SQLite + Postgres in one call. `explain`, `schema` modes. CSV-baseline savings math | ~2,300 tok / query on 100+ row result sets |
| `ashlr__bash` | Shell with stderr-safe auto-compression + structured summaries for `git status`, `ls`, `ps`, `npm ls` | 60–85% on verbose-output commands |

Plus three agents that mirror the WOZCODE tri-agent pattern:

| Agent | Model | Role |
|-------|-------|------|
| `ashlr:code` | sonnet | Main coding agent. Delegates when appropriate. |
| `ashlr:explore` | haiku | Read-only codebase exploration (cheap, fast). |
| `ashlr:plan` | haiku | Architecture + implementation planning (cheap, fast). |

And **four hooks** that make savings automatic instead of opt-in:

| Hook | Event | What it does |
|------|-------|--------------|
| `tool-redirect` | PreToolUse on Read/Grep/Edit | Nudges the agent to use the `ashlr__*` equivalent — savings become automatic, not reliant on the agent remembering. |
| `commit-attribution` | PreToolUse on Bash | Rewrites `git commit -m "..."` to append `Assisted-By: ashlr-plugin`. Skips if `Co-Authored-By:` / `Assisted-By:` is already present. Toggle off via `ashlr.attribution: false`. |
| `edit-batching-nudge` | PostToolUse on Edit | After 3 edits in the same 60-second window, nudges the agent to batch — real ~40% token saving on repeat-edits. |
| `session-start` | SessionStart | Once-per-day activation notice. |

Plus a **status-line integration** (`scripts/savings-status-line.ts`) that shows session + lifetime token savings live in the Claude Code status bar. Install with `bun run ~/.claude/plugins/ashlr-plugin/scripts/install-status-line.ts`.

## Install

**Prerequisites:** [bun](https://bun.sh) ≥ 1.3 and Claude Code. No account, no API key.

### 🪄 Fastest — one-liner

```bash
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

Then inside Claude Code:

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

Restart Claude Code. Done.

### 🧠 Ask Claude Code to do it

Copy and paste this into any Claude Code session:

```
Install the ashlr-plugin for me:

1. Run in a terminal:
   curl -fsSL plugin.ashlr.ai/install.sh | bash

2. Then inside this session, run these two slash commands:
   /plugin marketplace add ashlrai/ashlr-plugin
   /plugin install ashlr@ashlr-marketplace

3. Restart this Claude Code session, then verify:
   /ashlr-status
```

Claude Code runs the shell command, then the slash commands, then asks you to restart.

### 🔨 Fully manual (if you want to see every step)

```bash
# 1. Clone to Claude Code's plugin cache
git clone https://github.com/ashlrai/ashlr-plugin \
  ~/.claude/plugins/cache/ashlr-marketplace/ashlr

# 2. Install MCP deps (or skip — the SessionStart hook auto-installs on first run)
cd ~/.claude/plugins/cache/ashlr-marketplace/ashlr && bun install

# 3. Inside Claude Code
#   /plugin marketplace add ashlrai/ashlr-plugin
#   /plugin install ashlr@ashlr-marketplace

# 4. Restart Claude Code, then verify
#   /ashlr-status
```

### Verify it's working

Look for **`ashlr:code`** on the right side of the input field — that's the badge confirming the MCP server connected. Or run:

```
/ashlr-status     # plugin health + core library version + genome detection
/ashlr-savings    # running token-savings total
/ashlr-benchmark  # benchmark against your current project
```

### About the auto-install

Since v0.3.0, the `SessionStart` hook detects a missing `node_modules/` and runs `bun install` transparently on first session load. You shouldn't need to `bun install` yourself.

## Commands

| Command | Description |
|---------|-------------|
| `/ashlr-savings` | Show estimated tokens saved this session and lifetime |
| `/ashlr-settings` | View or change plugin settings (attribution, toolRedirect, statusLine toggles, etc.) |
| `/ashlr-status` | Plugin status + MCP server health + genome detection |
| `/ashlr-recall` | Recall saved user context and preferences from `~/.ashlr/recall.json` |
| `/ashlr-update` | `git pull` the plugin, `bun install`, and report what changed |
| `/ashlr-benchmark` | Run the benchmark harness against your current project |

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
