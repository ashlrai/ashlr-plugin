# Call ashlr's MCP tools from any agent pipeline

`measure.ts` is a small MCP stdio client with no dependencies beyond Bun. It
spawns `scripts/ashlr-mcp.ts` (the same entry point MCP hosts launch), runs
the `initialize` handshake, lists tools, and calls `ashlr__read` and
`ashlr__grep`. For each file it prints the bytes a raw read would put into
context next to what `ashlr__read` actually returned.

Use it to answer "does ashlr help on *my* repo?" before you wire it into a
host, or copy `McpStdioClient` into your own agent loop.

```bash
# From a clone of this repo, after `bun install`:
bun examples/mcp-client/measure.ts                                 # this repo's large files
bun examples/mcp-client/measure.ts --cwd ~/code/app src/server.ts logs/app.log
bun examples/mcp-client/measure.ts --cwd ~/code/app README.md --json
```

Output from a real run on this repo:

```text
ashlr MCP server: 40 tools

file                                raw bytes  ashlr__read bytes  saved
servers/efficiency-server.ts            47301               7878  83.3%
CHANGELOG.md                           206367               1999  99%
README.md                               17837               2005  88.8%

ashlr__grep "registerTool": 3221 bytes returned
≈ tokens = bytes / 4 (the plugin's estimate)
```

Things to know:

- With no LLM provider configured (as in this run), `ashlr__read` keeps the
  head and tail of a large file and elides the middle (`snipCompact`), and
  labels the result `confidence: low`. Pass `bypassSummary: true` when the
  agent needs the full file. Small files come back essentially unchanged, so
  savings grow with file size. Configure `ANTHROPIC_API_KEY`, Ollama, or
  `ASHLR_LLM_URL` to get summaries instead of snips.
- The script sets `ASHLR_ALLOW_PROJECT_PATHS` to `--cwd`, because the server
  refuses paths outside the allowed project roots.
- It runs with a throwaway `HOME`, so your real `~/.ashlr` stats are not
  touched. Drop that from `env` if you want the calls counted in
  `/ashlr-savings`.

Tested by `__tests__/examples-mcp-client.test.ts`, which runs a real stdio
session against a generated 130 KB log file.
