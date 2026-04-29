---
name: ashlr-compact
description: Identify stale tool results accumulating in the conversation history and surface a recompression plan.
---

Read `~/.ashlr/session-history/<sessionId>.jsonl` using the `ashlr__read` tool (or Bash if the path resolves) and then run the following analysis logic:

1. **Find the session ID**: It is in `~/.ashlr/last-project.json` under the `sessionId` key. Read that file first.

2. **Read the session history**: Read `~/.ashlr/session-history/<sessionId>.jsonl`. Each line is a JSON object with fields: `ts`, `tool`, `sizeBytes`, `contentSha8`, `turn`, `sessionId`.

3. **Compute current turn count**: Count the total number of lines in the history file — this is `currentTurn`.

4. **Classify entries by staleness**:
   - `turnDelta = currentTurn - entry.turn`
   - Fresh: `turnDelta < 5` (freshness 1.0)
   - Stale: `5 ≤ turnDelta < 15` (freshness 0.5)
   - Very stale: `turnDelta ≥ 15` (freshness 0.2)

5. **Aggregate**:
   - Total stale results: count of entries where `turnDelta ≥ 5`
   - Total stale bytes: sum of `sizeBytes` for stale entries
   - Per-tool breakdown: group by `tool`, show count + bytes

6. **Print the report** to the user in this format:
   ```
   ashlr-compact: Stale result analysis
   ─────────────────────────────────────
   Session turns:    <currentTurn>
   Stale results:    <count> (turnDelta ≥ 5)
   Stale volume:     ~<KB> KB

   By tool:
     <tool>          <count> results · ~<KB> KB
     ...

   Recompression opportunity: ~<staleKB> KB could be freed by re-running
   these reads now (the fresh results would replace stale ones in context).

   Suggested actions:
   ```
   Then list the top 5 stale entries (by sizeBytes descending) and suggest
   re-running the specific tool that produced them (e.g., "re-run ashlr__read
   on <implied subject>" if tool is ashlr__read or Read).

7. **Inject recompression hint** as your next assistant message context:
   > "ashlr: The above stale results are from 5+ turns ago. If any are still
   > needed, consider re-running the relevant reads now with fresh context.
   > Stale results from earlier turns remain in the conversation history and
   > count against the context window even when no longer load-bearing."

If the history file does not exist or is empty, tell the user: "No ashlr session history found — the tracker starts recording after the first ashlr__read or ashlr__grep call."

If total stale bytes < 5 KB, tell the user: "Session looks clean — less than 5 KB of stale tool output. No recompression needed yet."
