# Enable `ashlr__pipe`

The [tool catalog](../servers/_tool-catalog.json) marks `ashlr__pipe` as
**experimental**. It runs model-authored JavaScript on the MCP server and is
**off by default**: the server does not register it or advertise it in
`tools/list` unless enabled.

Set `ASHLR_PIPE_ENABLE=1` in the MCP server process environment before starting
the server. For a host that supports an `env` object in its MCP server
configuration, add this entry to that server's `env` object:

```json
{
  "ASHLR_PIPE_ENABLE": "1"
}
```

Restart the MCP server after changing its environment, then check `tools/list`
for `ashlr__pipe`. Only the exact value `1` enables registration. To turn it
off, remove the setting or give it another value and restart the server;
the tool will no longer appear in `tools/list`.

Enabling pipe exposes `ctx.grep`, `ctx.read`, `ctx.ls`, and `ctx.glob`.
`ctx.bash` requires the separate `ASHLR_PIPE_ALLOW_BASH=1` setting as well;
it grants shell access and should be enabled only when needed. See the
[pipe guide](ashlr-pipe.md) for usage, limits, and security details, and
[experimental status](pipe-experimental-status.md) for the catalog fields and
registration behavior.
