---
name: ashlr-tour
description: 60-second guided walkthrough of the ashlr-plugin on the current project — proves the value of the tools on real files.
---

You are giving a first-run tour of the ashlr-plugin. Execute the following sequence in order, narrating cleanly between tool calls. Each narration must be **at most 2 sentences** — short, instructional, second-person ("you"), not hype. Do not dump raw payloads unless asked: summarize what the user should notice (byte counts, compression ratio, savings deltas).

### Step 1 — current state

Run the `/ashlr-status` skill (or read `~/.ashlr/stats.json` directly). Narrate: what ashlr currently sees (MCP servers active, genome present?, lifetime tokens saved so far). Keep it to one line.

### Step 2 — tree view

Call `ashlr__tree` on the current working directory (`cwd`).

Narrate: "Here is what `ashlr__tree` shows the model instead of dozens of `ls`/`Read` calls — a compressed structural view of your repo."

### Step 3 — read a real file

Pick the **largest TypeScript file in `cwd`** (walk the tree, ignore `node_modules`, `dist`, `.git`). Call `ashlr__read` on it. After the call, fetch the raw byte count (e.g. via `wc -c`) and compare to the returned payload length.

Narrate: "That file is X bytes on disk; `ashlr__read` returned Y bytes (≈Z% of the original) — head + tail preserved, middle snipped. The model sees a smaller slice for the same signal."

### Step 4 — show the receipts

Call `ashlr__savings` and display the totals block verbatim inside a fenced code block.

Narrate: "Those two calls alone saved roughly N tokens (≈ $X). Multiply across a working session and it adds up fast."

### Step 5 — three concrete next steps

End the tour with exactly these three bullets, formatted as copy-pasteable snippets:

1. **Try a real question with genome-aware grep:**
   ```
   Use ashlr__grep to find "<something real in your repo>"
   ```
2. **Unlock deeper savings (−84% on grep) by mapping the genome:**
   ```
   /ashlr-genome-init
   ```
3. **Install the status-line so savings follow you everywhere:**
   ```
   /ashlr-settings set statusLine true
   ```

Close with one sentence only: "That's the tour — run `/ashlr-savings` any time to see running totals."

### Rules

- Do not run tools outside this sequence during the tour.
- If any step errors (e.g. no TS files in cwd, MCP server down), note it in one line and continue to the next step.
- Never exceed 2 sentences of narration per step. The tools do the talking.
