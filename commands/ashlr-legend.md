---
name: ashlr-legend
description: Decode every element of the ashlr status line (plain-text legend).
---

Run the status-line legend and render its output to the user.

```sh
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/print-legend.ts"
```

Capture stdout and display it verbatim inside a fenced code block (```) so the frame and column alignment render correctly.

Do not paraphrase or reorder the rows. If the user asks about one element, answer from the matching row after the block.
