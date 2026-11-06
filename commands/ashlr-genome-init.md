---
name: ashlr-genome-init
description: Initialize a `.ashlrcode/genome/` in the current project to make indexed knowledge available to ashlr__grep.
---

Initialize a genome for the user's current project.

Run the following Bash command:

```
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/genome-init.ts --dir "$(pwd)"
```

Pass `--force` only if the user explicitly asks to overwrite an existing genome.
Pass `--minimal` only if the user asks to skip the auto-populated architecture/conventions sections.
Pass `--summarize` if the user wants to use a local Ollama model to generate concise CLAUDE.md summaries instead of truncating. Requires Ollama running locally — falls back gracefully to truncation if unavailable.

After the command runs:

- Relay the script's stdout verbatim as the response.
- If the script exits non-zero because a genome already exists, tell the user to re-run with `/ashlr-genome-init --force` only if they confirm they want to overwrite.
- Do not read or modify any generated files unless the user asks.

No preamble, no trailing summary beyond the script's output.
