# ashlr-plugin

[![landing page](./docs/assets/og.png)](https://plugin.ashlr.ai/)

**Landing page:** [plugin.ashlr.ai](https://plugin.ashlr.ai/) · **Core library:** [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency) · **License:** MIT

Open-source Claude Code plugin that **cuts token usage** via genome-aware file retrieval, snipCompact + tiktoken-accurate compression, LLM-backed summarization for large outputs, and an active genome scribe loop. Open-source alternative to [WOZCODE](https://wozcode.com). Mean **−79.5%** savings on files ≥ 2 KB ([benchmarks](./docs/benchmarks.json)).

## What it does

Replaces Claude Code's built-in file/shell/SQL/network workflows with **9 MCP tools** that return fewer tokens per call while preserving the information the agent actually needs:

| Tool | Mechanism | Typical saving |
|------|-----------|----------------|
| `ashlr__read` | `snipCompact` + optional LLM summary on files > 16 KB | **−79.5%** on files ≥ 2 KB ([benchmarks](./docs/benchmarks.json)) |
| `ashlr__grep` | Genome-aware RAG when `.ashlrcode/genome/` exists; ripgrep fallback with summary option | 40–85% on projects with a genome |
| `ashlr__edit` | In-place search/replace with diff summary only; strict-by-default for safety | 20–50% on structured edits |
| `ashlr__sql` | SQLite + Postgres one-shot. `explain`, `schema` modes. LLM summary on 100+ row results | ~2,300 tok / query on large results |
| `ashlr__bash` | Shell with stderr-safe auto-compression + structured summaries for `git status`, `ls`, `ps`, `npm ls`. LLM summary on generic >16 KB output | 60–85% on verbose-output commands |
| `ashlr__tree` | gitignore-aware directory tree with per-dir truncation + size/LOC modes | one call replaces 3–5 `ls`/`find`/`Read` round-trips |
| `ashlr__http` | HTTP fetch with readable-extract (HTML), array-elide (JSON), and private-host safety | 60–80% on doc-page lookups |
| `ashlr__diff` | Adaptive git diff (stat/summary/full) with LLM summary on big diffs | up to **99%** on large changelogs |
| `ashlr__logs` | Tail with level filter + dedupe + LLM summary on busy logs | 50–94% depending on error density |

Plus `ashlr__genome_propose` / `_consolidate` / `_status` for the active genome scribe loop (see below), `ashlr__bash_start` / `_tail` / `_stop` / `_list` for long-running background commands, and `ashlr__savings` for the live dashboard.

Three agents mirror the WOZCODE tri-agent pattern:

| Agent | Model | Role |
|-------|-------|------|
| `ashlr:code` | sonnet | Main coding agent. Delegates when appropriate. |
| `ashlr:explore` | haiku | Read-only codebase exploration (cheap, fast). |
| `ashlr:plan` | haiku | Architecture + implementation planning (cheap, fast). |

**Six hooks** make savings automatic and upgrades safe:

| Hook | Event | What it does |
|------|-------|--------------|
| `tool-redirect` | PreToolUse on Read/Grep/Edit | Nudges the agent to use the `ashlr__*` equivalent — savings become automatic. |
| `commit-attribution` | PreToolUse on Bash | Rewrites `git commit -m "..."` to append `Assisted-By: ashlr-plugin`. Opt-out via `ashlr.attribution: false`. |
| `edit-batching-nudge` | PostToolUse on Edit | After 3 edits in a 60-second window, nudges the agent to batch. |
| `genome-scribe-hook` | PostToolUse on Edit | On substantial edits (>20 LOC or architectural paths), suggests recording the decision via `ashlr__genome_propose`. |
| `session-start` | SessionStart | Runs the baseline scanner, auto-`bun install`s if needed, cleans up stale plugin-version caches, emits once-per-day activation notice. |

Plus a **status-line integration** (`scripts/savings-status-line.ts`) showing session + lifetime savings with a 7-day Braille sparkline. Install with `bun run ~/.claude/plugins/cache/ashlr-marketplace/ashlr/<version>/scripts/install-status-line.ts`.

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

Since v0.3.0, the `SessionStart` hook detects a missing `node_modules/` and runs `bun install` transparently on first session load. Since v0.6.0, that same hook also removes stale plugin-version caches so old versions don't interfere with the current install.

## Commands

| Command | Description |
|---------|-------------|
| `/ashlr-doctor` | 11-check diagnostic — plugin root, bun, deps, MCP server reachability, stats.json integrity, genome detection, settings, hooks |
| `/ashlr-tour` | 60-second guided walkthrough that runs each core tool on your current project |
| `/ashlr-status` | Compact plugin status — MCP server health + core library version + genome detection |
| `/ashlr-savings` | Live dashboard: session + lifetime + per-tool breakdown + 30-day totals with `$` savings + 7-day sparkline |
| `/ashlr-benchmark` | Run the token-savings benchmark against your current project |
| `/ashlr-settings` | View or change toggles (`attribution`, `toolRedirect`, `editBatchingNudge`, `statusLine*`, etc.) |
| `/ashlr-genome-init` | Initialize `.ashlrcode/genome/` in the current project for the −84% grep path |
| `/ashlr-ollama-setup` | Diagnose Ollama for `/ashlr-genome-init --summarize`; recommend + smoke-test a fast 3B model |
| `/ashlr-recall` | Read user-saved preferences from `~/.ashlr/recall.json` |
| `/ashlr-update` | `git pull` the plugin + `bun install` + report what changed |

### Local Ollama setup for `--summarize`

`/ashlr-genome-init --summarize` uses a local Ollama model to write concise CLAUDE.md summaries. Run `/ashlr-ollama-setup` first to verify Ollama is installed and running, and to pull the recommended model (`llama3.2:3b`, ~2 GB). Add `--yes` (or export `ASHLR_OLLAMA_AUTO=1`) for an unattended install. The script smoke-tests the model in under 30 s and warns if your only installed models are ≥20B params — those will time out during summarization.

## How the efficiency tech works

All the primitives live in the shared [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency) library, also used by the standalone CLI [`ashlrcode`](https://github.com/ashlrai/ashlrcode). One implementation, two consumers.

- **Genome RAG** — `.ashlrcode/genome/` stores a sectioned, evolving project spec. `ashlr__grep` retrieves only task-relevant sections via TF-IDF or optional Ollama semantic search. The **genome scribe loop** (v0.5.0+) keeps the genome current while you code — agents propose updates via `ashlr__genome_propose`, and `ashlr__genome_consolidate` merges them (optionally LLM-powered).
- **Accurate token estimation** — core-efficiency v0.2.0 uses real tiktoken (`cl100k_base` / `o200k_base`), ~12.9% more accurate than chars/4 on code. Every savings figure in the dashboard uses the accurate count.
- **3-tier compression** — `autoCompact` (LLM summarize old turns) → `snipCompact` (truncate tool results > 2 KB) → `contextCollapse` (drop short/duplicate messages).
- **LLM summarization (v0.6.0+)** — `servers/_summarize.ts` routes large tool output through your local LLM (`http://localhost:1234/v1` LM Studio default; cloud override via `ASHLR_LLM_URL` + `ASHLR_LLM_KEY`). Per-tool prompts preserve what matters (file:line refs, stack traces, signatures). 5 s timeout → graceful snipCompact fallback. 1-hour SHA-256 cache.
- **Provider-aware budget** — system prompt = 5% of the provider's context limit, capped at 50K. Anthropic 200K → 10K budget; xAI 2M → 50K budget.

## Status

**v0.6.0 shipping.** 216 tests pass, CI green, plugin marketplace published, landing page live at [plugin.ashlr.ai](https://plugin.ashlr.ai/).

Highlights across the 0.1→0.6 arc:
- ✅ 9 MCP tools + 6 hooks + 9 slash commands
- ✅ Real tiktoken token counting (v0.2.0)
- ✅ WOZCODE feature parity (v0.3.0)
- ✅ Active genome scribe loop + bash-session control-plane (v0.5.0)
- ✅ LLM summarization on 6 tools + stale-cache cleanup + setup polish (v0.6.0)
- ✅ Benchmark suite + reproducible numbers in [`docs/benchmarks.json`](./docs/benchmarks.json)
- ✅ Zero telemetry, no account, MIT

Roadmap:
- Tier-3 summarization for `ashlr__http` (pending — HTML/JSON summarize has hallucination risk)
- MySQL support for `ashlr__sql`
- Publish `@ashlr/core-efficiency` to npm

## License

MIT — [LICENSE](./LICENSE).
