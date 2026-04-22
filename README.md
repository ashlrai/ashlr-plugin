# ashlr-plugin

Cut Claude Code token usage by **−79.5% on average** — 14 MCP tools that return less without losing what matters.

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
[![SafeSkill 55/100](https://img.shields.io/badge/SafeSkill-55%2F100_Use%20with%20Caution-orange)](https://safeskill.dev/scan/ashlrai-ashlr-plugin)

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

| MCP tool | Description |
|---|---|
| `ashlr__read` | `snipCompact` + optional LLM summary on files > 16 KB. Mean **−79.5%** on files ≥ 2 KB. |
| `ashlr__grep` | Genome-aware RAG when `.ashlrcode/genome/` exists; ripgrep fallback with LLM summary. |
| `ashlr__edit` | In-place search/replace — returns diff summary only, not the full file. |
| `ashlr__multi_edit` | Batch multiple search/replace edits in one call. |
| `ashlr__savings` | Live token-savings dashboard: session + lifetime + per-tool breakdown. |
| `ashlr__sql` | SQLite + Postgres one-shot. `explain` and `schema` modes. LLM summary on 100+ row results. |
| `ashlr__bash` | Shell with auto-compression + structured summaries for `git`, `ls`, `ps`, `npm ls`. |
| `ashlr__bash_start` / `_tail` / `_stop` / `_list` | Long-running background command control plane. |
| `ashlr__tree` | gitignore-aware directory tree with per-dir truncation + size/LOC modes. |
| `ashlr__http` | HTTP fetch with readable-extract (HTML), array-elide (JSON), and private-host safety. |
| `ashlr__diff` | Adaptive git diff (stat/summary/full) with LLM summary on big diffs. |
| `ashlr__logs` | Tail with level filter + dedupe + LLM summary. |
| `ashlr__genome_propose` / `_consolidate` / `_status` | Active genome scribe loop — keeps `.ashlrcode/genome/` current as you code. |
| `ashlr__orient` | Codebase orientation: entry points, key files, dependency graph. |
| `ashlr__glob` | gitignore-aware file glob with size/LOC metadata. |
| `ashlr__webfetch` | Fetch + extract web pages with token budget. |
| `ashlr__issue` / `ashlr__pr` | GitHub issue and PR management. |
| `ashlr__ask` | Ask a question, get a structured answer with citations. |

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

**Prerequisites:** [bun](https://bun.sh) ≥ 1.3 and Claude Code. No account, no API key.

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
| `/ashlr-allow` | Auto-approve every ashlr MCP tool — run once after install |
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
