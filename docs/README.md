> **Internal reference only.** Canonical public docs: [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs) (source: `site/content/docs/`).

<!-- fresh:begin version-table -->
| Source | Version |
| --- | --- |
| package.json | 1.37.1 |
| Latest released changelog (2026-10-25) | 1.37.1 |

Validate manifests with `bun run version:check`; regenerate the tool catalog with `bun run gen:tool-catalog`.
<!-- fresh:end -->

This directory contains internal architecture notes, runbooks, and operational docs for contributors and maintainers. It is not the public documentation site.

## Experimental pipe tool

`ashlr__pipe` executes model-authored JavaScript on the server and is disabled by default. To opt in, set `ASHLR_PIPE_ENABLE=1` in the MCP server's environment before starting it. Only the value `1` enables registration; restart the server after changing the setting.

The pipe provides `ctx.grep`, `ctx.read`, `ctx.ls`, and `ctx.glob`. Shell access through `ctx.bash` is separately disabled by default and requires `ASHLR_PIPE_ALLOW_BASH=1` as well as the pipe opt-in. See the [pipe guide](ashlr-pipe.md) for configuration, usage, and security details.

## Files in this directory

| File | Purpose |
|---|---|
| [`commands.md`](commands.md) | Current terminal and Claude Code slash-command reference |
| [`ashlr-command-examples.md`](ashlr-command-examples.md) | Illustrative slash-command invocations and output |
| [`ashlr-pipe.md`](ashlr-pipe.md) | Experimental pipe tool configuration, usage, and security |
| `architecture.md` | Full system architecture reference for contributors |
| `benchmarks.md` | Benchmark methodology and raw data |
| `benchmarks.json` | Single-repo benchmark snapshot (ashlr-plugin source) |
| `benchmarks-v2.json` | Cross-language benchmark (TS + Python + Rust) |
| `telemetry.md` | Telemetry privacy contract : what is and isn't sent |
| `pricing.md` | Internal pricing model and tier definitions |
| `cloud-genome.md` | Cloud genome sync deep-dive |
| `multi-host-mcp.md` | Multi-host MCP setup (Cline, Claude Desktop, Codex CLI) |
| [`codex-quickstart.md`](codex-quickstart.md) | One-page Codex CLI quickstart: plugin install, verification, MCP-only setup |
| `operations.md` | Operations runbook |
| `deploy.md` | Deployment guide |
| `platform-support.md` | Windows / macOS / Linux platform matrix |
| [`self-tuning.md`](self-tuning.md) | Self-tuning compression: misses, bounds, stored state, `ASHLR_TUNING=off` |
| [`PHANTOM-USAGE.md`](PHANTOM-USAGE.md) | Running under `phantom exec`: `phm_` placeholders, proxy base URLs, LiteLLM notes |
| [`phantom-preflight.md`](phantom-preflight.md) | Opt-in `phantom agent doctor` preflight line via `ASHLR_PHANTOM_PREFLIGHT` |

For public user-facing documentation, see `site/content/docs/` or visit [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs).
