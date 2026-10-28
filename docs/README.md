> **Internal reference only.** Canonical public docs: [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs) (source: `site/content/docs/`).

<!-- fresh:begin version-table -->
| Source | Version |
| --- | --- |
| package.json | 1.37.1 |
| Latest released changelog (2026-10-25) | 1.37.1 |

Validate manifests with `bun run version:check`; regenerate the tool catalog with `bun run gen:tool-catalog`.
<!-- fresh:end -->

This directory contains internal architecture notes, runbooks, and operational docs for contributors and maintainers. It is not the public documentation site.

## Files in this directory

| File | Purpose |
|---|---|
| [`commands.md`](commands.md) | Current terminal and Claude Code slash-command reference |
| `architecture.md` | Full system architecture reference for contributors |
| `benchmarks.md` | Benchmark methodology and raw data |
| `benchmarks.json` | Single-repo benchmark snapshot (ashlr-plugin source) |
| `benchmarks-v2.json` | Cross-language benchmark (TS + Python + Rust) |
| `telemetry.md` | Telemetry privacy contract : what is and isn't sent |
| `pricing.md` | Internal pricing model and tier definitions |
| `cloud-genome.md` | Cloud genome sync deep-dive |
| `multi-host-mcp.md` | Multi-host MCP setup (Cline, Claude Desktop, Codex CLI) |
| `operations.md` | Operations runbook |
| `deploy.md` | Deployment guide |
| `platform-support.md` | Windows / macOS / Linux platform matrix |
| [`self-tuning.md`](self-tuning.md) | Self-tuning compression: misses, bounds, stored state, `ASHLR_TUNING=off` |

For public user-facing documentation, see `site/content/docs/` or visit [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs).
