# `ashlr__pipe` experimental status

This file records the rollout status of `ashlr__pipe` as declared in the
[tool catalog](../servers/_tool-catalog.json). The catalog entry is the source
of truth for what the MCP server registers; regenerate it with
`bun run gen:tool-catalog` after editing a tool module.

| Fact | Value | Catalog field |
| --- | --- | --- |
| Tool | `ashlr__pipe` | `name` |
| Status | Experimental — the description is prefixed `[EXPERIMENTAL]` | `description` |
| Default | Off by default — not registered in `tools/list` unless the enable variable is set | `enableEnv` |
| Enable variable | `ASHLR_PIPE_ENABLE`; only the value `1` enables registration | `enableEnv` |
| Bash opt-in | `ctx.bash` additionally requires `ASHLR_PIPE_ALLOW_BASH=1` | `description` |
| Handler | `./pipe-server-handlers`, lazy-loaded on first call | `module` |

## What the gate does

`registerLazyTools()` in [`servers/_lazy-tools.ts`](../servers/_lazy-tools.ts)
skips any catalog entry whose `enableEnv` variable is not exactly `"1"`. With
`ASHLR_PIPE_ENABLE` unset or set to any other value, `ashlr__pipe` is absent
from `tools/list`, excluded from the advertised tool count, and its handler
module is never imported.

Because `ctx.bash` is a separate opt-in, `ASHLR_PIPE_ENABLE=1` alone exposes
only the read-only methods `ctx.grep`, `ctx.read`, `ctx.ls`, and `ctx.glob`.

For usage, parameters, and security details see the [pipe guide](ashlr-pipe.md);
the public page is `site/content/docs/tools/pipe.mdx`.
