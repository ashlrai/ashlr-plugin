# Command examples

These are **excerpts of real output**, captured with a fresh home directory and no recorded savings. Results vary with the installation and project. Slash-command excerpts come from their documented scripts or tool; `/ashlr-help` displays the literal text in its command definition.

### `ashlr-plugin codex-doctor`

```text
ashlr Codex doctor: ok
- plugin manifest: present
- MCP server: present (ashlr-mcp)
```

### `/ashlr-start`

```text
You just installed ashlr. Let's show you what it does.
This wizard takes about 60 seconds. Press Enter to accept defaults at
```

### `ashlr-plugin stats --json`

```json
{
  "schemaVersion": 2,
  "sessions": {},
  "lifetime": {
    "calls": 0,
    "tokensSaved": 0,
    "rawTotal": 0,
    "byTool": {},
    "byDay": {}
  }
}
```

### `/ashlr-savings`

```text
this session           all-time
  calls    0             calls    0
  saved    0 tok (est.)  saved    0 tok (est.)
  cost     ≈ $0.0000     cost     ≈ $0.0000
```

### `/ashlr-dashboard`

```text
  stats path: ~/.ashlr/stats.json
```

### `ashlr-plugin tools`

```text
ashlr MCP tools (54)
```

### `/ashlr-help`

```text
ashlr slash commands
```

### `ashlr-plugin codex-install --dry-run`

```text
ashlr Codex install dry run:
- would add mcp_servers.ashlr to ~/.codex/config.toml
- command: ashlr-mcp
```

### `ashlr-plugin genome-refresh`

```text
[genome-refresh-worker] no pending files
[ashlr] genome refresh: 0 files, 0 updated, 0 invalidated, 0 genome root(s)
```

### `/ashlr-genome-loop`

```text
  last consolidation: (never)
```

### `/ashlr-legend`

```text
             Dim when idle; pulses during a saving event.
```

