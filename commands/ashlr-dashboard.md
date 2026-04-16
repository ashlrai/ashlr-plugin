---
name: ashlr-dashboard
description: Rich token-savings dashboard — per-tool bar charts, 7d/30d sparklines, projected annual savings, and cost in dollars.
---

Run the dashboard script via Bash and show the user its output verbatim.

Steps:

1. Run this command:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/savings-dashboard.ts
   ```

   If `$CLAUDE_PLUGIN_ROOT` is unset, fall back to resolving the plugin root by walking up from the current command file to find `.claude-plugin/plugin.json`, or use the path already known from other ashlr commands.

2. Print the script's stdout **verbatim** inside a fenced code block (```) so the ANSI colors, Unicode box-drawing, bar charts, and sparklines all render correctly. The script is self-contained — it reads `~/.ashlr/stats.json` directly and renders a multi-panel view.

3. Do not paraphrase, re-order, or summarize the numbers. The dashboard is the output — the user wants to see it as-is.

4. After the verbatim block, add **at most one** short line of context:
   - If the dashboard shows the "No stats.json found yet" panel: "Run any `ashlr__read`, `ashlr__grep`, or `ashlr__edit` call and this dashboard will come alive."
   - If the projection section says "Not enough history yet": "Check back after a few more days of activity — the projection unlocks with ≥3 active days in the last 30."
   - Otherwise: say nothing extra. The dashboard speaks for itself.

Pricing note (only surface if asked): the dashboard uses a blended $5/M-token rate derived from Claude Sonnet 4.5 pricing ($3/M input, $15/M output) as a rough honest estimate for read-heavy workloads.

Related: `/ashlr-savings` gives the compact text-only version.
