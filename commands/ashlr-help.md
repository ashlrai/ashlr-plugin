---
name: ashlr-help
description: List every ashlr slash command with a one-line description, grouped by category.
---

Print the following table verbatim inside a fenced code block so column alignment renders correctly. No preamble, no trailing summary beyond the one-line pointer at the bottom.

```
ashlr slash commands

─── Onboarding ────────────────────────────────────────────────────────────
  /ashlr-start         First-run wizard (doctor + perms + demo + genome + pro)
  /ashlr-tour          60-second guided walkthrough on the current project
  /ashlr-demo          30-second scripted showcase of ashlr token savings
  /ashlr-allow         Auto-approve every ashlr MCP tool in settings.json
  /ashlr-ollama-setup  Diagnose + guide local Ollama install for summarization
  /ashlr-help          This screen

─── Token meter ──────────────────────────────────────────────────────────
  /ashlr-savings       Session + lifetime token-savings report with cost
  /ashlr-dashboard     Rich dashboard — bar charts, sparklines, annual projection
  /ashlr-badge         Generate an SVG savings badge for your GitHub README
  /ashlr-usage         Tool usage patterns from the session log
  /ashlr-benchmark     Run token-savings benchmark against the current project
  /ashlr-legend        Plain-text legend for every status-line element
  /ashlr-context-status Embedding cache stats — size, hit rate, projects tracked

─── Genome ───────────────────────────────────────────────────────────────
  /ashlr-genome-init       Initialize .ashlrcode/genome/ in the current project
  /ashlr-genome-loop       Inspect + control the auto propose/consolidate loop
  /ashlr-genome-keygen     Generate the X25519 keypair for team-cloud genome v2
  /ashlr-genome-team-init  Initialize a team-cloud genome (admin, once per repo)
  /ashlr-genome-push       Push local genome to team cloud (auto at SessionEnd)
  /ashlr-team-invite       Invite a teammate to your ashlr team by email
  /ashlr-recall            Recall saved user context from ~/.ashlr/recall.json
  /ashlr-handoff           Generate a context-pack for the next session

─── Upgrade ──────────────────────────────────────────────────────────────
  /ashlr-upgrade       Terminal-native free → Pro / Team checkout (90 seconds)
  /ashlr-settings      View or change ashlr-plugin settings

─── Diagnostics ──────────────────────────────────────────────────────────
  /ashlr-doctor        Under-10-second health check of your ashlr install
  /ashlr-status        Plugin + MCP server + genome status report
  /ashlr-errors        Recent MCP server errors (deduplicated)
  /ashlr-hook-timings  Per-hook latency report (p50 / p95 / max)
  /ashlr-report-crash  Upload a recent crash dump to the maintainer (opt-in)
  /ashlr-update        Update the plugin to the latest version from git
```

After the block, print exactly one line:

> Tip: run /ashlr-savings any time to see your running totals.
