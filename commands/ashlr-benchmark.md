---
name: ashlr-benchmark
description: Run the ashlr-plugin token-savings benchmark against the current project.
---

Benchmark the plugin's `snipCompact` savings on the user's actual code.

Steps:

1. Determine a target directory:
   - Prefer `<cwd>/src` if it exists.
   - Otherwise try `<cwd>/lib`, `<cwd>/app`, then `<cwd>` itself.
   - If none of these contain any `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`,
     `.rs`, `.java`, or similar source files, tell the user:

     ```
     ashlr-benchmark: no source files detected in <cwd>.
     Run it against a specific file instead, e.g.:
       bun run ${CLAUDE_PLUGIN_ROOT}/servers/bench.ts --path <file>
     ```

     and stop.

2. Run via Bash. The plugin root is exposed to hooks and commands via the
   `${CLAUDE_PLUGIN_ROOT}` environment variable. If that variable is empty or
   unset, the plugin is not loaded — abort with this exact message and stop:

   ```
   ashlr plugin not loaded — run /plugin install ashlr@ashlr-marketplace first.
   ```

   Otherwise:

   ```
   bun run ${CLAUDE_PLUGIN_ROOT}/servers/bench.ts --dir <target-dir>
   ```

3. Parse the output. The bench script prints a table of files with their raw
   byte counts vs. snipCompact byte counts and a percent saved. Reproduce the
   table in the response, then prepend a one-line headline:

   ```
   mean savings on files ≥ 2KB: X%
   ```

   Compute the mean across only files whose raw size is ≥ 2048 bytes (smaller
   files are pass-through in the redirect hook and skew the average).

4. If the bench script fails (missing file, exit non-zero), surface stderr
   verbatim and suggest running with `--path <single-file>` to narrow the
   problem.

No preamble, no trailing summary — just the headline plus the table.
