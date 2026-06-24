---
name: ashlr-help
description: List every ashlr slash command with a one-line description, grouped by category.
---

Print the following table verbatim inside a fenced code block so column alignment renders correctly. No preamble, no trailing summary beyond the one-line pointer at the bottom.

```
ashlr slash commands

─── Tier 0: Start here ────────────────────────────────────────────────────
  /ashlr-start     First-run wizard (doctor + perms + demo + genome + pro)
  /ashlr-savings   Session + lifetime token-savings report with cost
  /ashlr-dashboard Rich dashboard — bar charts, sparklines, annual projection
  /ashlr-doctor    Under-10-second health check of your ashlr install
  /ashlr-help      This screen

─── Tier 1: Daily use ─────────────────────────────────────────────────────
  /ashlr-resume    Resume your last session — files, branch, suggested next
  /ashlr-handoff   Generate a context-pack for the next session
  /ashlr-brief     Tunable response-shortening (lite/standard/concise) —
                   30–55% output-token reduction with auto-clarity exceptions
  /ashlr-eco-mode  Toggle eco mode (auto-compact, genome-grep, smart routing)
  /ashlr-tier      Three-phase tiered delegation: explore → code → plan
  /ashlr-update    Update the plugin to the latest version from git
  /ashlr-allow     Auto-approve every ashlr MCP tool in settings.json
  /goal            Register an objective → plan milestones → advance next as a
                   sandboxed proposal-only run (review via `ashlr inbox`)
  /loop            Run the goal-aware fleet conductor over enrolled repos —
                   one tick or --watch continuous; proposal-only, kill-switch gated

─── Tier 2: Genome / team ─────────────────────────────────────────────────
  /ashlr-genome-init       Initialize .ashlrcode/genome/ in the current project
  /ashlr-genome-push       Push local genome to team cloud (auto at SessionEnd)
  /ashlr-genome-loop       Inspect + control the auto propose/consolidate loop
  /ashlr-genome-keygen     Generate the X25519 keypair for team-cloud genome v2
  /ashlr-genome-rewrap     Re-wrap team-genome DEK for a new or rotated member
  /ashlr-genome-team-init  Initialize a team-cloud genome (admin, once per repo)
  /ashlr-team-invite        Invite a teammate to your ashlr team by email
  /ashlr-upgrade            Terminal-native free → Pro / Team checkout (90 seconds)

─── Tier 3: Power ─────────────────────────────────────────────────────────
  /ashlr-spawn         Spawn a named delegation pattern (triage-issues,
                       refactor-files, codebase-explain, pr-review-sweep,
                       parallel-test-fix)
  /ashlr-parallelize   Run the same task on N files in parallel sub-agents
  /ashlr-orchestrate   Expand a goal into a task graph, preview the DAG,
                       and run it (Pro 3 nodes / Team 10, local-only MVP)
  /ashlr-orchestrate-status
                       Inspect past /ashlr-orchestrate runs — list recent
                       or drill into a single graph by id
  /ashlr-budget        Set/check/clear a session spend cap ($X or tokens=N)
  /ashlr-tour          60-second guided walkthrough on the current project
  /ashlr-benchmark     Run token-savings benchmark against the current project
  /ashlr-settings      View or change ashlr-plugin settings
  /ashlr-hook-timings  Per-hook latency report (p50 / p95 / max)
  /ashlr-report-crash  Upload a recent crash dump to the maintainer (opt-in)
  /ashlr-status        Plugin + MCP server + genome status report
  /ashlr-ollama-setup  Diagnose + guide local Ollama install for summarization
  /ashlr-compact       Recompress stale tool results from the conversation

─── MCP tools (call directly, or via hook redirect) ───────────────────────
  ashlr__websearch     Token-efficient web search — dedup by domain, snip snippets,
                       synthesize summary for >3 results. Replaces WebSearch.
  ashlr__task_list     Compact task list — filter by status/owner, limit rows (default 30),
                       column view (taskId/status/subject/ageMin). Replaces TaskList.
  ashlr__task_get      Compact single task — snipCompacts descriptions >2KB.
                       Replaces TaskGet.
  ashlr__notebook_edit Compact Jupyter cell edit output (only edited cell + neighbors).
                       Replaces NotebookEdit.
  ashlr__write         Compact file-write acknowledgement (no echo of content).
                       Replaces Write.

─── Status-line legend ────────────────────────────────────────────────────
  ashlr ·   brand label + activity dot (dim idle, pulses on save event)
  ⠀⠄⠇⣿    heartbeat glyph — braille wave when active, dim dot when idle
  7d ▁▂▃▅  7-day sparkline; tallest cell = busiest day
  ctx:NN%   context-window pressure  green<60  yellow<80  orange<95  red 95+
  session   tokens saved this terminal session
  lifetime  tokens saved across all sessions
  tip:…     rotating daily hint (disable: /ashlr-settings set statusLineTips false)
```

After the block, print exactly one line:

> Tip: run /ashlr-savings any time to see your running totals.
