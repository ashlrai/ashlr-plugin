---
name: ashlr-doctor
description: Diagnose an ashlr-plugin install — checks plugin path, version, MCP servers, hooks, stats, genome, and settings in under 10 seconds.
---

Run the diagnostics script and show the user what's wrong (and how to fix it).

Steps:

1. Run this command via Bash:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts
   ```

   If `$CLAUDE_PLUGIN_ROOT` is unset, fall back to resolving the plugin root by walking up from the current command file to find `.claude-plugin/plugin.json`, or use the path already known from other ashlr commands.

2. Print the script's stdout verbatim inside a fenced code block. Do not paraphrase, truncate, or re-order lines — the block is designed to be copy-pasted into a GitHub issue.

3. Read the final summary line (`N warnings · M failures`). If either count is nonzero, ask the user a single targeted follow-up:

   > "I see {N} warning(s) and {M} failure(s) above. Want me to apply the suggested fixes?"

   Do not apply fixes without confirmation. Each `⚠` / `✗` line already contains the exact command to run.

4. If the script itself exits non-zero (couldn't find the plugin root at all), print the stderr and stop — nothing else will work until that's resolved.

## Cloud check

The report includes a **cloud** section that pings `GET /healthz` on the
ashlr backend with a 3-second timeout. Possible status lines:

- `cloud: healthy (Xms)` — backend reachable; X is the round-trip time.
- `cloud: unreachable (timeout/error)` — backend not responding. This is a
  **warning only** — it does not mark the install as unhealthy or cause
  the script to exit 1. The fix line suggests
  `set ASHLR_API_URL_DISABLE=1 to suppress, or check https://status.ashlr.ai`.
- `cloud: disabled (ASHLR_API_URL_DISABLE=1)` — check intentionally
  suppressed. Use this in offline environments or CI runs without internet.

**Env vars that control the cloud check:**

| Variable | Default | Effect |
|---|---|---|
| `ASHLR_API_URL` | `https://api.ashlr.ai` | Override the backend URL (e.g., point at staging or localhost). |
| `ASHLR_API_URL_DISABLE` | *(unset)* | Set to `1` to skip the ping entirely. |

If `$ARGUMENTS` contains `--errors`, also run:

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/errors-report.ts" $ARGUMENTS
```

(Strip `--errors` from the forwarded arguments if the script doesn't accept it.) Append its stdout verbatim under a `## Recent errors` section after the main diagnostics block. Display it inside a fenced code block.

No preamble. No trailing summary beyond the follow-up question.
