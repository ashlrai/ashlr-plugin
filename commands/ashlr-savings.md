---
name: ashlr-savings
description: Show estimated tokens and cost saved by the ashlr-plugin this session and lifetime.
---

Call the `ashlr__savings` MCP tool and show its output to the user **verbatim** inside a fenced code block (```) so the ASCII bar charts and column alignment render correctly.

The tool already returns a rich multi-line report covering:
- Session age and pricing model in use
- Two-column summary (this session vs all-time): calls, tokens saved, estimated dollar cost saved
- Per-tool breakdown for the current session (calls, tokens, proportional bar, percentage)
- A 7-day sparkline of daily tokens-saved (scaled to the busiest day)
- Pro upgrade nudge telemetry (when the user has crossed the 50k threshold at least once): `shown N · clicked M · rate P%`. Pro/Team users see the same stats labeled "historical" — no live nudge renders anymore.

After the verbatim block, add **at most one** short line:
- If session `calls` is 0: "No ashlr__read/grep/edit calls yet — try those in place of the built-ins to start accumulating savings."
- If session `calls` is non-zero and lifetime `calls` is under 20: "Still warming up — numbers get more meaningful after a few dozen calls."
- Otherwise: say nothing extra. The report speaks for itself.

Pricing note (only surface if the user asks how the dollar figure is derived): the report uses Claude Sonnet 4.5 input pricing ($3.00 per million tokens) by default. Override with the `ASHLR_PRICING_MODEL` env var (`sonnet-4.5` | `opus-4` | `haiku-4.5`).

Do not paraphrase the numbers — the user wants the exact tool output, not a rewritten summary.

Want a richer view? `/ashlr-dashboard` renders a multi-panel dashboard with ANSI colors, per-tool bar charts, 7-day and 30-day sparklines, top projects, and a projected-annual-savings extrapolation.
