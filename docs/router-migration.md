# Router Migration Guide (v1.24)

## What changed

Starting with v1.24, ashlr runs as a **single MCP process** hosting all 40
tools instead of spawning one child process per tool. The canonical entry point
is `servers/_router.ts`.

The old architecture spawned up to 12 separate `mcpServers` entries in
`plugin.json`. Each entry was its own Bun process, each with its own SQLite
handle, summarizer pool, and genome LRU cache. Cold-start summed up across all
of them; memory usage scaled linearly with the number of tools in flight.

The router consolidates this: one process, one SQLite handle, one LLM pool,
one startup cost. Measured cold-start went from ~200-400ms (aggregate N
processes) to ~75ms (single process with all 40 handlers).

## plugin.json already updated

As of v1.24, `.claude-plugin/plugin.json` contains a single entry:

```json
{
  "mcpServers": {
    "ashlr": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs", "servers/_router.ts"]
    }
  }
}
```

Fresh installs get this automatically.

## Users with legacy multi-entry config

Before v1.24, `plugin.json` listed one `mcpServers` entry per server
(efficiency-server, grep-server, etc.). If a user installed ashlr before v1.24
and has not re-run `/ashlr-allow`, their `~/.claude/settings.json` may still
contain the old entries alongside (or instead of) the new single entry.

**Detection:** The orient-nudge hook (`hooks/orient-server.ts`) detects the
legacy multi-MCP config on session start and emits a `legacy_mcp_config`
nudge. When this fires, the user sees:

> "ashlr: multiple MCP server entries detected (v1.23 config). Run
> `/ashlr-allow` to refresh to the single-router config and reduce process
> count."

**Migration steps (manual):**

1. Open `~/.claude/settings.json`.
2. Under `mcpServers`, delete any entries whose `args` array references a
   per-server file (e.g., `servers/efficiency-server.ts`, `servers/grep-server.ts`).
3. Keep (or add) the single entry:
   ```json
   "ashlr": {
     "command": "node",
     "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs", "servers/_router.ts"]
   }
   ```
4. Reload Claude Code (`/reset` or restart the app).

**Migration steps (automatic):**

Run `/ashlr-allow` — the onboarding wizard detects the legacy config and
offers to collapse it to the single entry.

## Legacy per-server entrypoints remain functional

`efficiency-server.ts`, `grep-server.ts`, and every other per-server file keep
their `if (import.meta.main)` guards. They still start correctly when invoked
directly:

```sh
bun run servers/efficiency-server.ts
```

This means:

- Users who keep the old `mcpServers` config continue to work without any
  hard break. Their tools call the per-server processes; those processes use
  the same handlers (via the shared registry in `_tool-base.ts`).
- Smoke tests that exercise individual servers directly continue to pass.
- No tools were changed — this is purely structural.

## Verification

After migrating, confirm a single ashlr process is running:

```sh
ps aux | grep ashlr
```

You should see one process referencing `_router.ts` (plus the Claude Code
parent). Before migration you would have seen one per tool.

Check cold-start:

```sh
bun run scripts/measure-cold-start.ts --runs 3
```

Expected output: p95 under 100ms.

Run the full test suite to confirm no regressions:

```sh
ASHLR_STATS_SYNC=1 bun test __tests__/router-dispatch.test.ts __tests__/router-cold-start.test.ts __tests__/router.test.ts
```
