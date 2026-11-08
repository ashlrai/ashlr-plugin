# Screenshot capture guide

Capture actual output from the current version. Values depend on the session, terminal width, and benchmark data; do not treat examples as guaranteed results.

1. **Status line:** In Claude Code, enable the status line and make tool calls. Capture the footer with session savings and, when enabled, the seven-day sparkline. See [status-line fields](../status-line-fields-q8.md).
2. **Savings dashboard:** Run `/ashlr-dashboard` in Claude Code, or from a checkout run `bun run scripts/savings-dashboard.ts --watch`. Watch mode redraws in an interactive terminal and renders once without a TTY.
3. **Read comparison:** Capture the same real file before and after `ashlr__read`. Label the selected read mode and measure the sizes in the captured run. Default reads can use an AST skeleton; `mode: "snip"` selects head-and-tail compaction.
4. **Benchmarks page:** Capture the current results and methodology at https://plugin.ashlr.ai/benchmarks. Interpret the reference numbers using [the benchmark methodology](../benchmarks.md).
5. **Pricing and landing pages:** Capture the current pages at https://plugin.ashlr.ai/pricing and https://plugin.ashlr.ai. Check displayed features and prices against the live page before publication.
