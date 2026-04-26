# ashlr-plugin

Cut Claude Code token usage by **−74% overall** on a typical workload (read **−82%**, grep **−93%**) — 40 MCP tools that return less without losing what matters. As of v1.22, hybrid LLM summarization (Anthropic Haiku 4.5 default → ONNX offline → local LM Studio opt-in) means real summarization for everyone, not just users running their own LLM. PreToolUse hooks default to true redirect (`ASHLR_HOOK_MODE=redirect`), so native `Read` / `Grep` / `Edit` / `Write` / `MultiEdit` / `NotebookEdit` / `WebSearch` / `Task*` inside your project route to ashlr equivalents instead of just nudging. See [docs/benchmarks.md](docs/benchmarks.md) for methodology + per-tool numbers.

**Supported on Windows, macOS, and Linux.** All hooks are TypeScript — no bash required. See [docs/install-windows.md](docs/install-windows.md) for Windows setup.

```bash
# macOS / Linux
curl -fsSL plugin.ashlr.ai/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
```

**Landing page:** [plugin.ashlr.ai](https://plugin.ashlr.ai/) · **Core library:** [`@ashlr/core-efficiency`](https://github.com/ashlrai/ashlr-core-efficiency) · **License:** MIT

[![CI — Linux](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml/badge.svg?label=Linux)](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml)
[![CI — macOS](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml/badge.svg?label=macOS)](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml)
[![CI — Windows](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml/badge.svg?label=Windows)](https://github.com/ashlrai/ashlr-plugin/actions/workflows/ci.yml)

**Tested on:** Ubuntu 22.04 · macOS 14 (Sonoma) · Windows Server 2022

---

## Permissions — stop the prompts first

Run this once after install so Claude Code stops asking on every tool call:

```
/ashlr-allow
```

That adds one wildcard per MCP server to `permissions.allow` in `~/.claude/settings.json`. Idempotent, restartless.

---

## 10-second demo

```
# 1. Install
curl -fsSL plugin.ashlr.ai/install.sh | bash
# Inside Claude Code:
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace

# 2. Use — read a large file (raw would be ~8,400 tokens)
ashlr__read  { "path": "src/server.ts" }
# Returns snipCompact view: head + tail, elided middle — ~1,700 tokens

# 3. Check savings
/ashlr-savings
```

```
Session savings  ·  ashlr-plugin v0.9.3
────────────────────────────────────────
  ashlr__read      6 calls    −42,180 tok   $0.13
  ashlr__grep      3 calls    −11,040 tok   $0.03
  ashlr__edit      2 calls     −3,200 tok   $0.01
  ─────────────────────────────────────────────
  Session total               −56,420 tok   $0.17
  Lifetime total             −284,900 tok   $0.86
  7-day sparkline   ▁▂▃▃▅▆█
```

---

## What you get

Core efficiency tools (replace built-ins with lower-token equivalents):

| MCP tool | Description |
|---|---|
| `ashlr__read` | `snipCompact` + LLM summary on files > 16 KB (Anthropic Haiku 4.5 default, ONNX/local fallback). Mean **−82.1%** on the v1.22 bench. Line numbers preserved on code files. |
| `ashlr__grep` | Genome-aware RAG when `.ashlrcode/genome/` or cloud genome exists; ripgrep fallback with LLM summary. |
| `ashlr__edit` | In-place search/replace — returns diff summary only, not the full file. Levenshtein candidates on miss. |
| `ashlr__edit_structural` | AST-aware rename (Unicode identifiers: `café`, `π`, CJK) + cross-file rename with `anchorFile` + `maxFiles` + shadowing guard + dryRun + extract-function with return-value detection (0 / 1 / N outputs). `.ts/.tsx/.js/.jsx`. |
| `ashlr__multi_edit` | Batch multiple search/replace edits in one call. |
| `ashlr__savings` | Live token-savings dashboard: session + lifetime + per-tool breakdown. |

Shell, data, and web tools:

| MCP tool | Description |
|---|---|
| `ashlr__bash` | Shell with auto-compression + pluggable summarizer registry (`servers/_bash-summarizers-registry.ts`) covering `git log`/`git diff`/`git show`, `ls`, `ps`, `npm ls`, unified test-runner output, `tsc`, and npm/bun/yarn/pnpm installs. Long-running commands survive timeouts via process-group SIGKILL. |
| `ashlr__bash_start` / `_tail` / `_stop` / `_list` | Long-running background command control plane. |
| `ashlr__sql` | SQLite + Postgres one-shot. `explain` and `schema` modes. LLM summary on 100+ row results. |
| `ashlr__http` | HTTP fetch with readable-extract (HTML), array-elide (JSON), and private-host safety. |
| `ashlr__webfetch` | Fetch + extract web pages with token budget. LLM summarization kicks in at 4 KB (web content is denser than code), 100 KB hard cap. |
| `ashlr__logs` | Tail with level filter + dedupe + LLM summary. |
| `ashlr__diff` | Adaptive git diff (stat/summary/full) with LLM summary on big diffs. |
| `ashlr__diff_semantic` | Semantic diff with meaning-aware change grouping. |
| `ashlr__test` | Structured test-runner output parser — bun/vitest/jest/pytest/go test. Compresses runner noise into one failure block per failure. |

Codebase navigation:

| MCP tool | Description |
|---|---|
| `ashlr__tree` | gitignore-aware directory tree with per-dir truncation + size/LOC modes. |
| `ashlr__glob` | gitignore-aware file glob with size/LOC metadata. |
| `ashlr__ls` | Directory listing with size metadata. |
| `ashlr__orient` | Codebase orientation: entry points, key files, dependency graph. |

Genome + GitHub:

| MCP tool | Description |
|---|---|
| `ashlr__genome_propose` / `_consolidate` / `_status` | Active genome scribe loop — keeps `.ashlrcode/genome/` current as you code. |
| `ashlr__issue` / `ashlr__pr` | GitHub issue and PR read ops. |
| `ashlr__issue_create` / `ashlr__issue_close` | GitHub issue write ops. Self-approval guard + `ASHLR_REQUIRE_GH_CONFIRM=1` opt-in confirmation. |
| `ashlr__pr_comment` / `ashlr__pr_approve` | GitHub PR write ops. `pr:"current"` resolves via `gh pr view`. No destructive ops (no merge/close/delete). |
| `ashlr__ask` | Ask a question, get a structured answer with citations. |

See [docs/architecture.md](./docs/architecture.md) for the full tool registry and router layout.

---

## Status-line

The status bar shows live session savings with a 7-day Braille sparkline:

```
┌─────────────────────────────────────────────┐
│  ashlr  −0 tok  $0.00  ▁▁▁▁▁▁▁  idle       │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ashlr  −12,480 tok  $0.04  ▁▂▃▄▅▆█  ██    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ashlr  −48,200 tok  $0.14  ▁▃▅▆██  ▓▓▓ !! │
└─────────────────────────────────────────────┘
```

`!!` appears when context pressure is high. Install:

```bash
bun run ~/.claude/plugins/cache/ashlr-marketplace/ashlr/<version>/scripts/install-status-line.ts
```

---

## Install

**Prerequisites:** Claude Code. [bun](https://bun.sh) ≥ 1.3 is auto-installed on first MCP server spawn — opt out with `ASHLR_NO_AUTO_INSTALL=1`. No account, no API key.

```bash
# One-liner
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

Then inside Claude Code:

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

Restart Claude Code. Verify with `/ashlr-status`.

**Manual install:**

```bash
git clone https://github.com/ashlrai/ashlr-plugin \
  ~/.claude/plugins/cache/ashlr-marketplace/ashlr
cd ~/.claude/plugins/cache/ashlr-marketplace/ashlr && bun install
# /plugin marketplace add ashlrai/ashlr-plugin
# /plugin install ashlr@ashlr-marketplace
```

---

## Commands

| Command | Description |
|---|---|
| `/ashlr-help` | List every ashlr slash command grouped by purpose (Onboarding / Token meter / Genome / Upgrade / Diagnostics) |
| `/ashlr-allow` | Auto-approve every ashlr MCP tool — covers canonical `mcp__plugin_ashlr_ashlr__ashlr__*` names, run once after install |
| `/ashlr-status` | Plugin health + MCP server reachability + genome detection |
| `/ashlr-savings` | Live dashboard: session + lifetime + per-tool + 7-day sparkline |
| `/ashlr-doctor` | 11-check diagnostic — deps, MCP reachability, hooks, settings |
| `/ashlr-tour` | 60-second guided walkthrough on your current project |
| `/ashlr-benchmark` | Token-savings benchmark against your current project |
| `/ashlr-genome-init` | Initialize `.ashlrcode/genome/` for the −84% grep path |
| `/ashlr-ollama-setup` | Diagnose Ollama for `--summarize`; pull recommended 3B model |
| `/ashlr-settings` | View or change plugin toggles |
| `/ashlr-update` | `git pull` + `bun install` + report what changed |

---

## Architecture

See [docs/architecture.md](./docs/architecture.md) for how the tools, hooks, and genome scribe loop fit together.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

## License

MIT — [LICENSE](./LICENSE).
