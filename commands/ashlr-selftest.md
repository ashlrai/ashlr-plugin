---
name: ashlr-selftest
description: Run every ashlr command's entry point against a throwaway fixture repo with --json and report pass/fail per command.
argument-hint: "[--json] [--only <id|command,...>] [--keep-tmp]"
---

Run the self-test script and show the results.

Steps:

1. Run this command via Bash:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/selftest.ts $ARGUMENTS
   ```

   If `$CLAUDE_PLUGIN_ROOT` is unset, fall back to resolving the plugin root by walking up from the current command file to find `.claude-plugin/plugin.json`, or use the path already known from other ashlr commands.

2. Print the script's stdout verbatim inside a fenced code block. Do not paraphrase or re-order lines.

   What it does: builds a throwaway git repo plus an isolated `$HOME` under `$TMPDIR`, then invokes the executable entry behind every `/ashlr-*` command and `ashlr-plugin` subcommand with `--json`. Script-backed commands must exit cleanly (and emit parseable JSON where a JSON surface exists); Pro-gated commands must produce their designed refusal; agent-side commands (env toggles, sub-agent fan-out) are listed as skipped with the reason. Every file in `commands/` must be covered or the run fails.

   Useful flags: `--json` (machine-readable report), `--only <id|command,...>` (one command or probe), `--keep-tmp` (keep the fixture for inspection).

3. Read the final summary line (`N passed · M failed · K skipped · U uncovered`). If `failed` or `uncovered` is nonzero, ask the user a single targeted follow-up:

   > "I see {M} failed probe(s){ and U uncovered command(s)}. Want me to dig into the first failure?"

   Do not start fixing anything without confirmation — each `✗` line already names the probe and the reason.

4. If the script itself exits 2 (fixture could not be built), print stderr and stop.

No preamble. No trailing summary beyond the follow-up question.
