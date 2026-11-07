> **Internal reference only.** Canonical public docs: [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs) (source: `site/content/docs/`).

<!-- fresh:begin version-table -->
| Source | Version |
| --- | --- |
| package.json | 1.38.5 |
| Latest released changelog (2026-11-07) | 1.38.5 |

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
| [`command-output-q8.md`](command-output-q8.md) | Representative command output from synthetic fixtures |
| [`parallelize-command-locations.md`](parallelize-command-locations.md) | Where the parallelize command is documented and the shared example |
| [`parallelize-example-inputs.md`](parallelize-example-inputs.md) | Inputs and limits of the parallelize example |
| [`parallelize-todo-example-inputs.md`](parallelize-todo-example-inputs.md) | Task and file inputs in the parallelize TODO example |
| [`parallelize-example-reference.md`](parallelize-example-reference.md) | Reference for the shared TODO-search example and its input files in both doc locations |
| [`parallelize-example-walkthrough.md`](parallelize-example-walkthrough.md) | Walkthrough of the parallelize request and file arguments |
| [`parallelize-example-review.md`](parallelize-example-review.md) | Checklist for keeping the shared parallelize example aligned |
| [`parallelize-example-comparison.md`](parallelize-example-comparison.md) | Side-by-side comparison of the command and site TODO-search examples |
| [`ashlr-pipe.md`](ashlr-pipe.md) | Experimental pipe tool configuration, usage, and security |
| [`pipe-enablement.md`](pipe-enablement.md) | Enable, verify, and disable the experimental pipe tool |
| [`pipe-experimental-status.md`](pipe-experimental-status.md) | Recorded experimental/default-disabled status and enable variable for `ashlr__pipe` |
| [`pipe-example-output-shape.md`](pipe-example-output-shape.md) | Grep text and derived file-and-line entries in the pipe example |
| [`pipe-grep-example-walkthrough.md`](pipe-grep-example-walkthrough.md) | Step-by-step trace of the pipe grep example |
| [`pipe-grep-line-processing.md`](pipe-grep-line-processing.md) | Split and filter stages of the pipe grep example |
| [`pipe-grep-reading-notes.md`](pipe-grep-reading-notes.md) | Input and string output of the advertised pipe grep example |
| [`pipe-grep-return.md`](pipe-grep-return.md) | `ctx.grep` return type inside `ashlr__pipe` and empty-result handling |
| [`pipe-grep-return-type.md`](pipe-grep-return-type.md) | The advertised `ctx.grep` example's documented string return type |
| [`pipe-grep-walkthrough.md`](pipe-grep-walkthrough.md) | End-to-end walkthrough of the advertised grep example and its string result |
| [`pipe-handler-grep-return.md`](pipe-handler-grep-return.md) | The handler-documented `ctx.grep` string return type and minimal invocation |
| [`pipe-example-data-flow.md`](pipe-example-data-flow.md) | Data flow of the working-directory pipe grep example |
| [`pipe-grep-example-output.md`](pipe-grep-example-output.md) | Text output shape of the advertised pipe grep example |
| [`pipe-server-grep-example.md`](pipe-server-grep-example.md) | The pipe handler's advertised direct grep example |
| [`summarize-marker-literals.md`](summarize-marker-literals.md) | Marker literals requested by the source-file summarizer |
| [`summary-marker-maintenance.md`](summary-marker-maintenance.md) | Review changes to the source summary marker instruction |
| [`summarize-marker-examples.md`](summarize-marker-examples.md) | Examples of the markers the read prompt preserves verbatim |
| [`summarize-marker-purpose.md`](summarize-marker-purpose.md) | Why the read prompt instructs the summarizer to preserve markers |
| [`summarize-marker-review.md`](summarize-marker-review.md) | Review checklist for the preserved-marker list |
| [`summarize-marker-source-map.md`](summarize-marker-source-map.md) | Source map of the marker list inside `PROMPTS` |
| [`summary-marker-reference.md`](summary-marker-reference.md) | Reference list of every preserved source summary marker |
| [`read-fidelity-marker-assertions.md`](read-fidelity-marker-assertions.md) | What the read-fidelity test asserts about marker preservation |
| [`regex-replacement-example.md`](regex-replacement-example.md) | Tested whole-match replacement example for TODO markers |
| `architecture.md` | Full system architecture reference for contributors |
| `benchmarks.md` | Benchmark methodology and raw data |
| [`benchmark-result-locations.md`](benchmark-result-locations.md) | Saved v2 result locations and their recorded methodologies |
| [`benchmark-v2-read-measurement.md`](benchmark-v2-read-measurement.md) | Read measurement, units, and scope of the saved v2 snapshot |
| [`benchmark-methodology-location.md`](benchmark-methodology-location.md) | Where each v2 snapshot stores its methodology and how it reaches readers |
| [`benchmark-methodology-guide.md`](benchmark-methodology-guide.md) | How to read the token-savings benchmark and its saved data |
| [`benchmark-methodology-source-map.md`](benchmark-methodology-source-map.md) | Which files carry the recorded methodology strings |
| [`benchmark-grep-interpretation.md`](benchmark-grep-interpretation.md) | How to interpret benchmark grep results |
| [`benchmark-grep-language-caveats.md`](benchmark-grep-language-caveats.md) | Language caveats of the fixed grep workload |
| [`benchmark-grep-pattern-inventory.md`](benchmark-grep-pattern-inventory.md) | Runner vs published grep pattern inventory |
| [`benchmark-grep-pattern-list.md`](benchmark-grep-pattern-list.md) | The five grep search strings in source order |
| [`benchmark-grep-patterns.md`](benchmark-grep-patterns.md) | The five benchmark grep queries the runner uses |
| [`benchmark-pattern-language-map.md`](benchmark-pattern-language-map.md) | Pattern-by-pattern language association map |
| [`benchmark-pattern-purpose.md`](benchmark-pattern-purpose.md) | Purpose of each benchmark grep pattern |
| [`benchmark-pattern-selection.md`](benchmark-pattern-selection.md) | Why the workload fixes its grep patterns |
| [`benchmark-rust-interpretation.md`](benchmark-rust-interpretation.md) | Short guide to the Rust match-rate caveat |
| [`benchmark-rust-pattern-caveat.md`](benchmark-rust-pattern-caveat.md) | The Rust match-rate caveat in the benchmark |
| [`benchmark-rust-pattern-caveats.md`](benchmark-rust-pattern-caveats.md) | Concrete Rust grep pattern caveats |
| [`benchmark-rust-pattern-interpretation.md`](benchmark-rust-pattern-interpretation.md) | Interpreting the Rust benchmark patterns |
| [`benchmark-rust-patterns.md`](benchmark-rust-patterns.md) | Rust patterns in the token-savings benchmark |
| [`grep-benchmark-coverage-questions.md`](grep-benchmark-coverage-questions.md) | Coverage questions for the grep benchmark |
| [`grep-rust-benchmark-caveat.md`](grep-rust-benchmark-caveat.md) | Rust caveat for the fixed grep workload |
| [`rust-grep-benchmark-interpretation.md`](rust-grep-benchmark-interpretation.md) | Interpreting the Rust grep benchmark |
| [`orchestrate-benchmark-interpretation.md`](orchestrate-benchmark-interpretation.md) | How to interpret local orchestrator benchmark results and their limits |
| [`orchestrate-benchmark-notes.md`](orchestrate-benchmark-notes.md) | Stub orchestrator benchmark workloads and options |
| [`orchestrate-benchmark-scope.md`](orchestrate-benchmark-scope.md) | What the orchestrator benchmark measures and its stated real-LLM limitation |
| [`orchestrate-real-llm-benchmark-status.md`](orchestrate-real-llm-benchmark-status.md) | Real-LLM benchmark TODO and latency caveat |
| [`orchestrate-real-llm-benchmark-note.md`](orchestrate-real-llm-benchmark-note.md) | Real-LLM mode flag and the bench script's timing caveat |
| [`orchestrate-quota-current-behavior.md`](orchestrate-quota-current-behavior.md) | Current Team quota boundary and future central enforcement |
| [`orchestrate-quota-follow-up.md`](orchestrate-quota-follow-up.md) | Team-tier central-quota TODO in the executor and the behavior it states today |
| [`orchestrate-quota-note.md`](orchestrate-quota-note.md) | Team-tier quota behavior in the executor and the central-quota follow-up |
| [`orchestrate-quota-notes.md`](orchestrate-quota-notes.md) | Pointer notes for the orchestration quota docs |
| [`orchestrate-quota-open-questions.md`](orchestrate-quota-open-questions.md) | Decision list for central Team quota enforcement |
| [`orchestrate-quota-questions.md`](orchestrate-quota-questions.md) | Team quota integration questions |
| [`orchestrate-team-quota-boundary.md`](orchestrate-team-quota-boundary.md) | Team quota boundary pointers |
| [`orchestrate-team-quota-followup.md`](orchestrate-team-quota-followup.md) | Team quota follow-up pointers |
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
| [`ashlr-handshake.md`](ashlr-handshake.md) | The `--ashlr-handshake` companion JSON contract (v1) |
| [`llm-providers.md`](llm-providers.md) | LLM provider hierarchy, env vars, and strict gateway targets |
| [`embeddings-gateway.md`](embeddings-gateway.md) | Opt-in OpenAI-compatible embeddings via `ASHLR_EMBED_FORMAT=openai` |
| [`embed-tuning.md`](embed-tuning.md) | Embedding cache cosine-threshold tuning |
| [`multi-turn-architecture.md`](multi-turn-architecture.md) | Multi-turn recompression architecture |
| [`router-migration.md`](router-migration.md) | Router migration guide |
| [`session-log-schema.md`](session-log-schema.md) | `~/.ashlr/session-log.jsonl` JSONL record schema |
| [`fleet-schema.md`](fleet-schema.md) | The `~/.ashlr-runs` fleet drop-zone wire contract |
| [`job-lifecycle.md`](job-lifecycle.md) | Job lifecycle states (generated from `servers/_job-lifecycle.ts`) |
| [`test-isolation.md`](test-isolation.md) | Why and how the test suite isolates Bun module state |
| [`status-line-fields-q8.md`](status-line-fields-q8.md) | Status line fields produced by `savings-status-line.ts` |
| [`install-prompt.md`](install-prompt.md) | Paste-this-block Claude Code install prompt |
| [`install-windows.md`](install-windows.md) | Windows install notes for ashlr-plugin |
| [`install.ps1`](install.ps1) | Windows PowerShell installer script |
| [`install.sh`](install.sh) | Claude Code one-liner installer script |
| [`github-oauth-onboarding.md`](github-oauth-onboarding.md) | GitHub sign-in to first cloud genome walkthrough |
| [`upgrade.md`](upgrade.md) | Terminal-native `/ashlr-upgrade` free-to-pro flow |
| [`team-genome.md`](team-genome.md) | Sharing a genome across a development team |
| [`billing.md`](billing.md) | Stripe tiers, integration architecture, lifecycle events |
| [`legal.md`](legal.md) | Pre-launch legal checklist (internal) |
| [`policy-packs.md`](policy-packs.md) | Team allow/deny/confirm tool-call policy packs |
| [`PRO_TIER.md`](PRO_TIER.md) | Pro tier positioning and feature notes |
| [`pro-backend-architecture.md`](pro-backend-architecture.md) | Pro backend architecture plan |
| [`bb-study.md`](bb-study.md) | Internal study of the get-bb/bb project |
| [`competitive-wozcode.md`](competitive-wozcode.md) | WozCode competitive learnings |
| [`email-templates.md`](email-templates.md) | React-email transactional template catalog |
| [`hero-video-script.md`](hero-video-script.md) | Hero video shooter's brief |
| [`producthunt.md`](producthunt.md) | ProductHunt launch draft |
| [`launch-post.md`](launch-post.md) | Launch post copy |
| [`social.md`](social.md) | Social copy for current positioning |
| [`launch/`](launch/README.md) | Versioned launch drafts (HN, Reddit, X) |
| [`press-kit/`](press-kit/fact-sheet.md) | Fact sheet, founder bio, logo and screenshot plan |
| [`assets/`](assets/) | README and site image assets |
| [`index.html`](index.html) | Standalone landing page served with the docs assets |
| [`CNAME`](CNAME) | Custom domain for GitHub Pages serving |

For public user-facing documentation, see `site/content/docs/` or visit [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs).
