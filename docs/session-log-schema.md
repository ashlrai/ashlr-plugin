# Session log schema

The ashlr session log is a JSONL file at `~/.ashlr/session-log.jsonl`. One
JSON object per line, one line per tool invocation, append-only, size-
capped at 10 MB with a cascading backup (`.jsonl.1` → `.jsonl.2`). The
format is designed to be stable across agents (Claude Code, Cursor, Goose
and any future consumer) so downstream tooling can parse it without
special-casing per-agent quirks.

## Line format

Each line is a single JSON object with the following fields:

```json
{
  "ts": "2026-04-18T22:14:03.127Z",
  "agent": "claude-code",
  "event": "tool_call",
  "tool": "ashlr__read",
  "cwd": "/Users/me/code/project",
  "session": "sess_abc123",
  "input_size": 240,
  "output_size": 8210
}
```

| Field          | Type    | Notes |
|----------------|---------|-------|
| `ts`           | string  | ISO 8601 UTC timestamp with millisecond precision |
| `agent`        | string  | Agent name. Currently `"claude-code"`; future agents add new values |
| `event`        | string  | One of `tool_call`, `tool_fallback`, `tool_error`, `tool_escalate` |
| `tool`         | string  | MCP tool name (e.g. `ashlr__read`), or `"unknown"` when the hook can't parse it |
| `cwd`          | string  | Absolute path of the agent's working directory at the time of the call |
| `session`      | string  | `CLAUDE_SESSION_ID`, or a hashed PPID fallback starting with `h` when unavailable |
| `input_size`   | number  | Byte size of the tool's input payload (JSON-stringified when not already bytes) |
| `output_size`  | number  | Byte size of the tool's output payload |

### Event vocabulary

- `tool_call` — the default. Tool ran to completion.
- `tool_fallback` — tool took the fallback path (e.g. genome empty, fell through to raw ripgrep; summarizer unavailable, fell through to head+tail bytes).
- `tool_error` — tool threw or returned non-zero.
- `tool_escalate` — tool returned a bypassSummary-style hint that the caller should retry with more context.

Consumers that don't know an `event` value should treat it as `tool_call`.

## Rotation

- Active file: `~/.ashlr/session-log.jsonl`.
- Once the active file crosses 10 MB, the next write:
  1. Renames `.jsonl.1` → `.jsonl.2` if a prior rotation exists (cascade keeps one generation of backup).
  2. Renames the active file → `.jsonl.1`.
  3. Starts a fresh active file.
- Maximum on-disk footprint is therefore ~20 MB (active ≤ 10 MB + one 10 MB backup). `.jsonl.2` is overwritten on the next rotation.

## Reading the log

- `bun run scripts/session-log-report.ts` produces a human-readable report covering the active file + any rotated backups.
- `/ashlr-usage` wraps that report as a Claude Code skill.
- `ashlr stats --json` (new in v1.11.0) prints the stats ledger at `~/.ashlr/stats.json` as JSON on stdout — the session log is the raw feed, stats.json is the aggregated view.

## Schema stability

This is schema version **1**. Breaking changes add a `schema_version` field at the top of the file (not per-line) and bump the number. Non-breaking additions (new `event` values, new optional fields) don't change the version. Consumers should tolerate unknown fields silently.

## Disabling

Set `ASHLR_SESSION_LOG=0` at shell startup to suppress the log entirely. The tools still work; they just don't record.
