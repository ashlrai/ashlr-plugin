---
name: ashlr-ollama-setup
description: Diagnose and guide local Ollama install so `/ashlr-genome-init --summarize` works reliably. Recommends a fast 3B model and smoke-tests it.
---

Run the guided Ollama setup script and relay its output.

Steps:

1. If the user asked for "automatic", "auto", "just install it", "yes", or
   passed a `--yes` / `-y` / `auto` argument, include `--yes` in the command
   below. Otherwise omit it — the script will print the exact `ollama pull`
   command for the user to run themselves.

2. Run this via Bash:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/ollama-setup.ts [--yes]
   ```

   If `$CLAUDE_PLUGIN_ROOT` is unset, resolve the plugin root the same way
   other ashlr commands do (walk up from this command file to find
   `.claude-plugin/plugin.json`).

3. Relay the script's stdout verbatim inside a fenced code block. Do not
   paraphrase or truncate — each line carries a glyph (`✓` pass, `✗` fail,
   `⚠` warn, `ℹ` info) and any `fix:` line is copy-pasteable.

4. If the script exits non-zero:
   - `1` means a user-actionable issue (Ollama not installed, daemon not
     running, or a model needs to be pulled). The output already contains
     the exact next command — do not invent your own instructions.
   - `2` means an internal error. Ask the user to file an issue with the
     output block.

5. If the script exits `0`, confirm briefly that `/ashlr-genome-init
   --summarize` will now use the recommended model. No other preamble.
