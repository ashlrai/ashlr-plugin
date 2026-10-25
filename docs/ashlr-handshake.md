# Ashlr companion handshake (v1)

`ashlr-plugin --ashlr-handshake` prints one JSON object and exits 0. `phm companions`,
`phm doctor` or an agent can call it instead of parsing `--help`. The same
contract is implemented by `stack --ashlr-handshake` (ashlr-stack) and
`locus --ashlr-handshake`.

```json
{
  "kind": "ashlr.handshake",
  "schema_version": 1,
  "name": "ashlr-plugin",
  "command": "ashlr-plugin",
  "version": "1.37.1",
  "protocols": { "ashlr.handshake": 1, "phantom.agent.preflight": 1 },
  "capabilities": ["token-efficient-tools", "mcp-server", "claude-code-plugin", "codex-install", "savings-stats", "agent-preflight", "doctor"],
  "health": { "status": "ok", "checks": [{ "id": "bun-on-path", "status": "ok" }, { "id": "phantom-on-path", "status": "absent" }] },
  "edits": ["~/.ashlr/", "~/.claude/settings.json", "~/.codex/config.toml"],
  "receipts": []
}
```

Rules every implementation follows:

- **Fast and local:** no network, no vault or keychain, and no secret values or project contents in the output.
- **Stable shape:** `kind` and `schema_version` identify the contract. New fields may be added in v1; renames or removals bump `schema_version`.
- **Ids:** `capabilities` and check `id`s are kebab-case. `protocols` maps a protocol name to the version spoken.
- **Health:** `health.status` is `ok`, `degraded` (works, something it relies on is missing) or `unknown`. A check status is `ok`, `missing` (counts against health) or `absent` (informational, such as phantom not installed when ASHLR_PHANTOM_PREFLIGHT is off).
- **Edits:** paths the CLI may write. `~/` is the home directory; other paths are relative to the project.
- **Receipts:** receipt kinds the CLI emits (none yet; reserved for receipt.v1).

The npm launcher (`scripts/ashlr-plugin.mjs`, plain node) answers before it looks for bun, so a machine without bun gets `bun-on-path: missing` and `degraded` instead of an error.
