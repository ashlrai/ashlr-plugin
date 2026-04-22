---
name: ashlr-hook-timings
description: Show per-hook latency report (p50/p95/max) from hook-timings.jsonl.
argument-hint: "[--hours N] [--compare] [--flags-only]"
---

Run the hook timings report and render its output to the user.

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/hook-timings-report.ts" $ARGUMENTS
```

Capture stdout and display it verbatim inside a fenced code block (```) so column alignment renders correctly.

The report covers:
- Header: total records, time window, overall median latency.
- Per-hook table: calls, p50, p95, max, error%, block%.
- Flagging lines for hooks where p95 > 200ms (⚠ threshold exceeded) or max >= 1s.
- If no records yet: a single plain-text prompt to enable hooks.

**Flags:**
- `--hours N` — narrow or widen the time window (default: 24h).
- `--compare` — show trend indicators (↓ improved / ↑ regressed) next to each hook's p95, comparing the current window against the previous equal-length window. A hook is "improved" when p95 dropped ≥20%, "regressed" when it grew ≥20%.
- `--flags-only` — output only the slow-hook warning lines (compact alert mode). Useful for scripting or quick checks. Exits silently when no flags exist.

After the verbatim block, add **at most one** short line:
- If the output contains "no records yet": "No timings recorded yet — run a few tool calls with hooks enabled."
- Otherwise: say nothing extra. The report speaks for itself.

Do not paraphrase the numbers.
