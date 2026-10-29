# Command reference

Use `ashlr-plugin` in a terminal. Use slash commands inside Claude Code. MCP tools are a separate surface available to supported hosts through `ashlr-mcp`; see [multi-host setup](multi-host-mcp.md). The former `ashlr` executable name belongs to Ashlr Hub.

## Terminal commands

Requires Bun 1.3 or newer. From a source checkout, replace `ashlr-plugin` with `bun run scripts/cli.ts`. Run project commands from the project directory.

| Command | Purpose |
|---|---|
| `ashlr-plugin stats --json [--session <id>] [--since <YYYY-MM-DD>] [--tool <name>]` | Print the local savings ledger or a filtered slice as JSON. |
| `ashlr-plugin tools [--json]` | List registered MCP tools. |
| `ashlr-plugin mcp` | Start the stdio MCP router. |
| `ashlr-plugin codex-start [--json]` | Run the Codex session-start lifecycle hook. |
| `ashlr-plugin codex-resume [--json]` | Run the Codex session-resume lifecycle hook. |
| `ashlr-plugin codex-end [--json]` | Run the Codex session-end lifecycle hook. |
| `ashlr-plugin codex-doctor [--json]` | Check installation and Codex packaging. Alias: `doctor`. |
| `ashlr-plugin codex-install --dry-run [--json]` | Preview Codex configuration changes. |
| `ashlr-plugin genome-refresh [--json]` | Refresh genome sections for changed files. |
| `ashlr-plugin selftest [--json] [--only <id,...>]` | Run every command's entry point against a throwaway fixture repo and report pass/fail per command. |
| `ashlr-plugin version` | Print the installed version. Aliases: `--version`, `-v`. |
| `ashlr-plugin help` | Show CLI usage. Aliases: `--help`, `-h`. |

`codex-install` currently supports preview only; pass `--dry-run`. Lifecycle commands run hooks and can update local session state. `genome-refresh` updates local genome state. They are not aliases for Claude Code slash commands.

## Claude Code slash commands

Start with `/ashlr-start`, then `/ashlr-savings`. Use `/ashlr-doctor` for diagnostics and `/ashlr-help` for the in-session menu. This table covers every command file shipped in `commands/`; follow its source link for arguments, prerequisites, confirmation steps, and side effects. Some commands require Pro, Team, or an installed companion CLI. Each example is illustrative: it shows an invocation and a representative output excerpt; values and wording can vary with local state.

| Command | Purpose | Example output |
|---|---|---|
| [`/ashlr-allow`](../commands/ashlr-allow.md) | Auto-approve every ashlr MCP tool so Claude Code stops prompting in bypass-permissions mode. | `/ashlr-allow` → `All ashlr MCP tool entries already in allowlist. Nothing to do.` |
| [`/ashlr-benchmark`](../commands/ashlr-benchmark.md) | Run the ashlr-plugin token-savings benchmark against the current project. | `/ashlr-benchmark` → `mean savings on files ≥ 2KB: 42%` |
| [`/ashlr-brief`](../commands/ashlr-brief.md) | Toggle response-shortening (caveman-inspired, ashlr-flavored) with three intensity levels. Trims filler from Claude's prose to save 30–55% on output tokens while keeping code blocks, errors, and destructive-action confirmations in full grammar. | `/ashlr-brief on standard` → `ashlr-brief: standard ON. Effective on the next response.` |
| [`/ashlr-budget`](../commands/ashlr-budget.md) | Set, check, or clear a session spend cap. Guards against runaway tool use in long sessions. | `/ashlr-budget tokens=200000` → `Budget set to 200000 tokens.` |
| [`/ashlr-compact`](../commands/ashlr-compact.md) | Identify stale tool results accumulating in the conversation history and surface a recompression plan. | `/ashlr-compact` → `less than 5 KB of stale tool output. No recompression needed yet.` |
| [`/ashlr-dashboard`](../commands/ashlr-dashboard.md) | Rich token-savings dashboard: per-tool bar charts, 7d/30d sparklines, projected annual savings, and cost in dollars. | `/ashlr-dashboard` → `no tool usage recorded yet.` |
| [`/ashlr-doctor`](../commands/ashlr-doctor.md) | Diagnose an ashlr-plugin install: checks plugin path, version, MCP servers, hooks, stats, genome, and settings in under 10 seconds. | `/ashlr-doctor` → `0 warnings · 0 failures` |
| [`/ashlr-eco-mode`](../commands/ashlr-eco-mode.md) | Toggle eco mode: aggressive token-saving behaviors that trade some response richness for lower session cost. | `/ashlr-eco-mode off` → `Eco mode OFF. All behaviors restored to defaults.` |
| [`/ashlr-fleet`](../commands/ashlr-fleet.md) | Explain the Phantom fleet pane (`/top`), local peers (`/peers`, `/send`), and governed Claude model routing provided by the Phantom mod. Requires Claude Code 2.1.309+ and a pinned Locus binding. | `/ashlr-fleet` → `/peers lists sessions in the local Locus peer registry.` |
| [`/ashlr-genome-init`](../commands/ashlr-genome-init.md) | Initialize a `.ashlrcode/genome/` in the current project so ashlr__grep can route through genome RAG for ~-84% token savings. | `/ashlr-genome-init` → `✓ Initialized genome at /project/.ashlrcode/genome/` |
| [`/ashlr-genome-keygen`](../commands/ashlr-genome-keygen.md) | Generate an X25519 keypair for team-cloud genome v2 encryption and register the public half with Ashlr. Run this once per machine before running /ashlr-genome-team-init. Safe to re-run: a no-op when the machine's key is already registered. | `/ashlr-genome-keygen` → `Already registered.` |
| [`/ashlr-genome-loop`](../commands/ashlr-genome-loop.md) | Inspect and control the automatic genome propose + consolidate loop (PostToolUse observer + SessionEnd consolidator). | `/ashlr-genome-loop off` → `ashlr genome loop: disabled` |
| [`/ashlr-genome-push`](../commands/ashlr-genome-push.md) | Push the local .ashlrcode/genome/ to the team cloud. Safe to run any time; invoked automatically at SessionEnd after consolidation. No-op when the repo has no .cloud-id (i.e. team-genome not initialized) or when ASHLR_CLOUD_GENOME_DISABLE=1. | `/ashlr-genome-push` → `Pushed 5 section(s) to genome-123.` |
| [`/ashlr-genome-rewrap`](../commands/ashlr-genome-rewrap.md) | Re-wrap the team-cloud genome DEK for every member with a current pubkey. Run this after a teammate rotates their keypair (/ashlr-genome-keygen --force) or joins the team and runs /ashlr-genome-keygen for the first time. Admin-only. | `/ashlr-genome-rewrap` → `Wrapped 2 envelope(s). Skipped 0 member(s) without a pubkey yet.` |
| [`/ashlr-genome-team-init`](../commands/ashlr-genome-team-init.md) | Initialize (or rewrap for new members of) a team-cloud genome for the current repo. One-time per repo by an admin; then teammates join via /ashlr-team-invite + /ashlr-genome-keygen + admin re-runs with --wrap-all. | `/ashlr-genome-team-init` → `Team-cloud genome initialized for this repo.` |
| [`/ashlr-handoff`](../commands/ashlr-handoff.md) | Generate a context-pack for the next session to resume cold. | `/ashlr-handoff` → `Branch:      main` |
| [`/ashlr-help`](../commands/ashlr-help.md) | List every ashlr slash command with a one-line description, grouped by category. | `/ashlr-help` → `/ashlr-doctor    Under-10-second health check of your ashlr install` |
| [`/ashlr-hook-timings`](../commands/ashlr-hook-timings.md) | Show per-hook latency report (p50/p95/max) from hook-timings.jsonl. | `/ashlr-hook-timings` → `ashlr hook timings · last 24h · 3 records · median 12ms` |
| [`/ashlr-leaderboard`](../commands/ashlr-leaderboard.md) | Opt in or out of the public ashlr savings leaderboard at plugin.ashlr.ai/community. Opt-in is OFF by default; when on, your GitHub handle and total tokens/$ saved are shown publicly (never your email). Requires a signed-in account that syncs stats (Pro/Team). | `/ashlr-leaderboard status` → `Leaderboard: off (opted out)` |
| [`/ashlr-legend`](../commands/ashlr-legend.md) | Decode every element of the ashlr status line (plain-text legend). | `/ashlr-legend` → `tokens saved in THIS terminal since the` |
| [`/ashlr-ollama-setup`](../commands/ashlr-ollama-setup.md) | Diagnose and guide local Ollama install so `/ashlr-genome-init --summarize` works reliably. Recommends a fast 3B model and smoke-tests it. | `/ashlr-ollama-setup` → `ollama pull llama3.2:3b` |
| [`/ashlr-orchestrate-status`](../commands/ashlr-orchestrate-status.md) | Inspect past /ashlr-orchestrate runs: list recent runs or drill into a single graph by id. | `/ashlr-orchestrate-status` → `No orchestration runs yet` |
| [`/ashlr-orchestrate`](../commands/ashlr-orchestrate.md) | Distributed-orchestration MVP: expand a goal into a task graph, preview the DAG, confirm, and run it (Pro / Team only). | `/ashlr-orchestrate "harden retry logic"` → `Press y to execute, n to cancel, e to edit YAML.` |
| [`/ashlr-parallelize`](../commands/ashlr-parallelize.md) | Spawn N parallel sub-agents: one per file: each applying the same task instruction. Merges results into a unified report. | `/ashlr-parallelize "explain exports" src/utils.ts` → `1 agents · task: explain exports` |
| [`/ashlr-report-crash`](../commands/ashlr-report-crash.md) | Upload a recent ashlr-plugin crash dump to the maintainer. Opt-in, already-redacted, one report per invocation. Gives the founder faster bug signal when something in the plugin threw. | `/ashlr-report-crash --dry-run` → `--dry-run: nothing uploaded.` |
| [`/ashlr-resume`](../commands/ashlr-resume.md) | Resume your last coding session: shows what you were doing, which files were active, and suggested next steps. | `/ashlr-resume` → `No prior sessions found` |
| [`/ashlr-savings`](../commands/ashlr-savings.md) | Show estimated tokens and cost saved by the ashlr-plugin this session and lifetime. | `/ashlr-savings` → `No ashlr__read/grep/edit calls yet` |
| [`/ashlr-selftest`](../commands/ashlr-selftest.md) | Run every ashlr command's entry point against a throwaway fixture repo with --json and report pass/fail per command. | `/ashlr-selftest` → `40 passed · 0 failed · 15 skipped · 0 uncovered` |
| [`/ashlr-settings`](../commands/ashlr-settings.md) | View or change ashlr-plugin settings. | `/ashlr-settings set statusLine true` → `statusLine: true` |
| [`/ashlr-spawn`](../commands/ashlr-spawn.md) | Spawn a named delegation pattern as one or more sub-agents. Patterns defined in _spawn-patterns.json. | `/ashlr-spawn triage-issues` → `1 agent(s) completed` |
| [`/ashlr-start`](../commands/ashlr-start.md) | First-run onboarding wizard for the ashlr-plugin. Guides users through doctor check, permissions, a live read demo, genome initialization, and a quick pro teaser: all in under 60 seconds. Run automatically on the first session; re-run manually any time with /ashlr-start. Use /ashlr-start --reset to re-arm the auto-trigger for the next session. | `/ashlr-start` → `Wizard complete. Run /ashlr-savings any time to see your running totals` |
| [`/ashlr-status`](../commands/ashlr-status.md) | Report the ashlr-plugin activation status and MCP server health. | `/ashlr-status` → `server:  ✓ reachable` |
| [`/ashlr-team-invite`](../commands/ashlr-team-invite.md) | Invite someone to your ashlr team by email. Sends a magic-link invite (admin role required). | `/ashlr-team-invite alice@example.com` → `✓ invite sent to alice@example.com. Expires in 7 days.` |
| [`/ashlr-tier`](../commands/ashlr-tier.md) | Three-phase tiered delegation: explore (haiku) → implement (sonnet) → integration-check (haiku). Routes each phase to the right model tier automatically. | `/ashlr-tier add rate limiting` → `Phase 1: Discovery (explore / haiku)` |
| [`/ashlr-tour`](../commands/ashlr-tour.md) | 60-second guided walkthrough of the ashlr-plugin on the current project: proves the value of the tools on real files. | `/ashlr-tour` → `This is what every element in your status line means` |
| [`/ashlr-update`](../commands/ashlr-update.md) | Update the ashlr-plugin to the latest version from its git remote. | `/ashlr-update` → `ashlr-plugin already up to date at abc1234.` |
| [`/ashlr-upgrade`](../commands/ashlr-upgrade.md) | Terminal-native free-to-pro upgrade for ashlr. Walks the user from free to Pro or Team in under 90 seconds without leaving the terminal. Primary path: GitHub OAuth sign-in. Fallback: magic-link email. Handles plan selection, Stripe checkout (with 7-day Pro trial on first checkout), and activation polling: all from the CLI. | `/ashlr-upgrade` → `Sign in with:` |
| [`/goal`](../commands/goal.md) | Create a goal, decompose it into milestones, and advance the next one as a sandboxed proposal-only run. | `/goal` → `Usage: ashlr goal "<objective>" [--project <repo>] [--allow-cloud] [--plan-only] [--direct]` |
| [`/loop`](../commands/loop.md) | Run the goal-aware fleet conductor over every enrolled repo: one tick (default) or continuous. | `/loop --dry-run` → `Any proposals filed await review in` |



## Common workflows

- Codex diagnostics: `ashlr-plugin codex-doctor --json`, then inspect `ashlr-plugin codex-install --dry-run --json` before changing host configuration.
- Local savings: `ashlr-plugin stats --json`; inside Claude Code use `/ashlr-savings` or `/ashlr-dashboard`.
- Session continuity: `/ashlr-handoff` before leaving Claude Code, `/ashlr-resume` when returning. Codex lifecycle commands above are intended for hooks.
- Team genome: follow the linked command prerequisites for key registration, team initialization, and invitations. These operations can contact cloud services; do not treat them as offline diagnostics.

The terminal surface is defined in [`scripts/cli.ts`](../scripts/cli.ts); slash command behavior is defined in the linked Markdown files.
