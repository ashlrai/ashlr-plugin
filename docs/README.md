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
| [`parallelize-example-inputs.md`](parallelize-example-inputs.md) | Inputs and limits of the parallelize example |
| [`parallelize-todo-example-inputs.md`](parallelize-todo-example-inputs.md) | Task and file inputs in the parallelize TODO example |
| [`parallelize-example-walkthrough.md`](parallelize-example-walkthrough.md) | Walkthrough of the parallelize request and file arguments |
| [`ashlr-pipe.md`](ashlr-pipe.md) | Experimental pipe tool configuration, usage, and security |
| [`pipe-experimental-status.md`](pipe-experimental-status.md) | Recorded experimental/default-disabled status and enable variable for `ashlr__pipe` |
| [`pipe-grep-example-walkthrough.md`](pipe-grep-example-walkthrough.md) | Step-by-step trace of the pipe grep example |
| [`pipe-grep-line-processing.md`](pipe-grep-line-processing.md) | Split and filter stages of the pipe grep example |
| [`pipe-grep-return.md`](pipe-grep-return.md) | `ctx.grep` return type inside `ashlr__pipe` and empty-result handling |
| [`pipe-grep-return-type.md`](pipe-grep-return-type.md) | The advertised `ctx.grep` example's documented string return type |
| [`summarize-marker-literals.md`](summarize-marker-literals.md) | Marker literals requested by the source-file summarizer |
| [`regex-replacement-example.md`](regex-replacement-example.md) | Tested whole-match replacement example for TODO markers |
| `architecture.md` | Full system architecture reference for contributors |
| `benchmarks.md` | Benchmark methodology and raw data |
| [`benchmark-v2-read-measurement.md`](benchmark-v2-read-measurement.md) | Read measurement, units, and scope of the saved v2 snapshot |
| [`benchmark-methodology-location.md`](benchmark-methodology-location.md) | Where each v2 snapshot stores its methodology and how it reaches readers |
| [`orchestrate-benchmark-interpretation.md`](orchestrate-benchmark-interpretation.md) | How to interpret local orchestrator benchmark results and their limits |
| [`orchestrate-benchmark-notes.md`](orchestrate-benchmark-notes.md) | Stub orchestrator benchmark workloads and options |
| [`orchestrate-benchmark-scope.md`](orchestrate-benchmark-scope.md) | What the orchestrator benchmark measures and its stated real-LLM limitation |
| [`orchestrate-real-llm-benchmark-status.md`](orchestrate-real-llm-benchmark-status.md) | Real-LLM benchmark TODO and latency caveat |
| [`orchestrate-real-llm-benchmark-note.md`](orchestrate-real-llm-benchmark-note.md) | Real-LLM mode flag and the bench script's timing caveat |
| [`orchestrate-quota-current-behavior.md`](orchestrate-quota-current-behavior.md) | Current Team quota boundary and future central enforcement |
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
