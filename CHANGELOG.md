# Changelog

All notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-04-15

Initial public release. Everything is v0.1-shaped; please report rough edges.

### Added
- **MCP server** (`servers/efficiency-server.ts`) exposing four tools over stdio:
  - `ashlr__read` — snipCompact on tool-results > 2KB; mean **−79.5%** tokens on files ≥ 2 KB ([benchmarks.json](./docs/benchmarks.json))
  - `ashlr__grep` — genome-aware retrieval via `retrieveSectionsV2` when `.ashlrcode/genome/` is present; ripgrep fallback
  - `ashlr__edit` — diff-format edits instead of full before/after
  - `ashlr__savings` — session + lifetime totals persisted at `~/.ashlr/stats.json`
- **Three agents** mirroring the WOZCODE tri-agent pattern:
  - `ashlr:code` (sonnet) — main agent, explicit delegation rules
  - `ashlr:explore` (haiku, read-only) — fast exploration, 400-word budget
  - `ashlr:plan` (haiku) — file-level plans, ≤ 500 words
- **Slash commands**: `/ashlr-status`, `/ashlr-savings`, `/ashlr-settings`
- **Session-start hook** — once-per-day activation notice
- **Benchmark harness** (`servers/bench.ts`) — reproducible, JSON output for CI
- **Landing page** at `docs/` served by GitHub Pages, reachable at `plugin.ashlr.ai`
- **CI pipeline** — typecheck both packages, MCP smoke test, Pages deploy on `main`
- **Publish script** `scripts/publish.sh` — idempotent GitHub publish + Pages config

### Design
- Efficiency primitives (genome, compression, budget) live in [`@ashlr/core-efficiency`](https://github.com/masonwyatt23/ashlr-core-efficiency) so both this plugin and the standalone [ashlrcode CLI](https://github.com/masonwyatt23/ashlrcode) consume the same library.
- MIT licensed, no account, no telemetry.

### Known limitations
- Claude Code doesn't run `bun install` on plugin install — one-time manual step required (see [README](./README.md#install))
- Savings tracking uses chars/4 heuristic; exact token counts only available at the provider's response boundary
- `ashlr__grep` genome path requires `.ashlrcode/genome/` to exist; for projects without one, falls back to plain ripgrep which is still lighter than the built-in Grep default
- `ashlr__edit` currently returns a diff summary without applying the edit; the parent `ashlr:code` agent wraps it with the actual Write/Edit call. A self-contained apply-and-report implementation is planned for v0.2.
