# ashlr-plugin Telemetry

## Overview

ashlr-plugin includes an **opt-in, privacy-first** telemetry pipeline that helps the maintainer tune heuristics (edit thresholds, embedding similarity cutoffs, LLM routing) with real-world data instead of guesses.

**Default: OFF.** Nothing is ever collected unless you explicitly enable it.

---

## How to opt in

**Via environment variable (session-scoped):**

```sh
export ASHLR_TELEMETRY=on
```

**Via config file (persistent):**

```json
// ~/.ashlr/config.json
{
  "telemetry": "opt-in"
}
```

On first opt-in, a one-line notice is printed at session start confirming what is collected and how to disable.

---

## How to opt out

**Environment variable (highest priority — overrides config):**

```sh
export ASHLR_TELEMETRY=off
```

**Config file:**

```json
// ~/.ashlr/config.json
{
  "telemetry": "off"
}
```

Either method immediately disables collection and flushing. No data is sent after the kill switch is set. The local buffer at `~/.ashlr/telemetry-buffer.jsonl` can be deleted manually at any time.

---

## What is collected

Only anonymized, aggregate-friendly event shapes. **No file paths, no grep patterns, no command content, no user identifiers, no repo names.**

### Event types

| Kind | Fields |
|------|--------|
| `tool_call` | `tool`, `rawBytes`, `compactBytes`, `fellBack`, `providerUsed`, `durationMs` |
| `pretooluse_block` | `tool`, `blockedTo`, `sizeRange` (`small`/`medium`/`large` bucket — never raw bytes) |
| `pretooluse_passthrough` | `tool`, `reason` (`below-threshold` / `out-of-cwd` / `plugin-tree` / `micro-edit` / `bypass`) |
| `version` | `pluginVersion`, `bunVersion`, `platform`, `arch` |

All events also include:

- `ts` — epoch seconds (not milliseconds, to save bytes)
- `kind` — event type string
- `sessionId` — a per-session opaque hex string (SHA-256 fold of a random seed; re-generated each session)

### What `sessionId` is

A 16-character hex string derived from a random seed at session start. It is deleted at session end. It allows the maintainer to correlate events *within* one session without identifying the user across sessions or installations. Re-installs and new sessions always generate a fresh value.

---

## What is NEVER collected

- File paths (absolute or relative)
- Grep search patterns
- File content, command arguments, or any user-authored text
- User names, email addresses, or identifiers
- Repo names, organization names, or project paths
- IP addresses (the server receives them transiently in HTTP headers but they are not stored)

A path-safety guard in the buffer writer (`looksLikePath`) rejects any event whose string values look like an absolute filesystem path. Events that fail this check are silently dropped rather than written.

---

## Local buffer

Events are buffered locally at:

```
~/.ashlr/telemetry-buffer.jsonl
```

The buffer is capped at **5,000 lines**. Older entries are evicted when the cap is exceeded. The buffer is a plain JSONL file — you can inspect it at any time:

```sh
cat ~/.ashlr/telemetry-buffer.jsonl | head -5
```

---

## Flusher

The buffer is flushed to the maintainer's collection endpoint:

1. **On session end** — spawned from the `session-end-consolidate` hook.
2. **On demand** — `bun run scripts/telemetry-flush.ts`.

The flusher has a **10-second network timeout**. On failure (network error, non-2xx response) the buffer is left untouched and retried on the next flush cycle. Failures are logged to stderr but never surfaced to the user.

---

## Endpoint contract

### POST `/v1/events`

**URL:** `https://telemetry.ashlr.ai/v1/events` (override with `ASHLR_TELEMETRY_URL` env var)

**Request:**

```json
{
  "sessionId": "a1b2c3d4e5f6a7b8",
  "events": [
    {
      "ts": 1720000000,
      "kind": "tool_call",
      "sessionId": "a1b2c3d4e5f6a7b8",
      "tool": "ashlr__read",
      "rawBytes": 8200,
      "compactBytes": 1100,
      "fellBack": false,
      "providerUsed": "anthropic",
      "durationMs": 42
    }
  ]
}
```

**Response (2xx):**

```json
{ "accepted": 1 }
```

On `2xx`, the flusher truncates the buffer to entries newer than the flush horizon (the `ts` of the last event in the batch). On any other status or network error, the buffer is left intact.

### Server-side requirements (for the maintainer)

To start receiving events, stand up a simple HTTPS function (Vercel/Cloudflare Workers/etc.) that:

1. Accepts `POST /v1/events` with `Content-Type: application/json`.
2. Parses `{ sessionId, events }` from the body.
3. Validates that no event field contains path-like strings (defense-in-depth).
4. Appends events to a time-series store (e.g. Tinybird, ClickHouse, Postgres `jsonb`).
5. Returns `{ accepted: N }` with status `200`.
6. Does NOT log request IP addresses to permanent storage.

**The endpoint does not need to exist for the plugin to function.** When the endpoint is unreachable, events are buffered locally and retried silently.

---

## Data retention promise

- **Raw events:** purged from the server after **30 days**.
- **Aggregate statistics** (e.g., p50 raw/compact byte ratios per tool per week): retained indefinitely for heuristic tuning.
- **Session IDs:** not cross-referenced with any user identity. Treated as opaque correlation tokens within a single session.

---

## Viewing telemetry status

Run `/ashlr-status` in Claude Code. The `## Telemetry snapshot` section includes:

```
  opt-in telemetry: OFF (default) · to enable: ASHLR_TELEMETRY=on
```

or when enabled:

```
  opt-in telemetry: ON · buffer: 42 events · to disable: ASHLR_TELEMETRY=off
```

---

## `/ashlr-settings telemetry off`

Running `/ashlr-settings telemetry off` writes `{ "telemetry": "off" }` into `~/.ashlr/config.json`, which disables collection and flushing for all future sessions.
