# Examples

Runnable recipes for using ashlr outside the Claude Code slash-command flow.
Each one is covered by a test in `__tests__/`, so it runs in CI.

| Recipe | What it shows | Test |
| --- | --- | --- |
| [`mcp-client/`](mcp-client/) | Drive the ashlr MCP server from your own agent or script over stdio, and measure `ashlr__read` / `ashlr__grep` savings on your own files | `__tests__/examples-mcp-client.test.ts` |

Host setup snippets (Cursor, Goose, Cline, Claude Desktop, generic MCP hosts)
are in [`docs/multi-host-mcp.md`](../docs/multi-host-mcp.md).
