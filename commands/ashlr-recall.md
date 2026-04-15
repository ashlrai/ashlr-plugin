---
name: ashlr-recall
description: Recall saved user context and preferences from ~/.ashlr/recall.json.
---

Read `~/.ashlr/recall.json` and display its contents as a compact key/value table.

Behavior:

1. If the file does not exist, print:

   ```
   ashlr-recall: no saved context yet.
   Tip: ask the agent to "remember <key>: <value>" or "save this preference: <X>"
        and it will be written to ~/.ashlr/recall.json for future sessions.
   ```

2. If the file exists, parse it as JSON (an object of `{ key: value }` string pairs)
   and render one line per entry:

   ```
   ashlr-recall (N items):
     <key>: <value>
     <key>: <value>
   ```

   Truncate values longer than 120 chars with an ellipsis.

3. If the file exists but is malformed JSON, report the parse error and the raw
   first 200 bytes — do not delete or rewrite the file.

Agent guidance (for future turns in this session):

- When the user says "remember", "save this", "keep this in mind", "note that",
  or any equivalent, treat it as a request to upsert a key/value pair into
  `~/.ashlr/recall.json`. Create the file (and `~/.ashlr/` directory) if missing.
- Use the Edit tool on the JSON file when possible; otherwise read+merge+write
  with the Write tool. Always preserve existing keys.
- At session start, if `~/.ashlr/recall.json` exists, read it once and surface
  any obviously relevant preferences (e.g. "user prefers concise output") before
  you start working.

No preamble, no trailing summary — just the table or the empty-state hint.
