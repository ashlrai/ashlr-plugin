# ashlr-plugin v1.24 — "Foundation"

Released 2026-04-28.

---

## What you'll feel

### Pro: your stats now follow you

If you upgrade to Pro, your per-session savings ledger syncs across every
machine at session end (push) and session start (pull). Open `/ashlr-dashboard`
on your laptop and your work desktop — same lifetime totals, same
`☁ N machines` badge in the status line. No manual export, no SSH tunneling.

### Pro: no Ollama required for genome summarization

The cloud LLM provider is live. When you run `/ashlr-genome-init` or the
scribe loop fires, summarization now routes to hosted infrastructure by
default — 5s timeout, SHA-256 cache, automatic fallback to ONNX or local
LM Studio if the cloud is unavailable. If you installed Ollama just for
ashlr, you can uninstall it.

### Free: faster startup, warmer RAG out of the box

All 40 tools now run in a single MCP process instead of N child processes.
Cold-start time drops noticeably, especially on slower machines.

Small projects also get automatic RAG benefits without running
`/ashlr-genome-init`. After the first grep returns, ashlr indexes your corpus
in the background (`setImmediate`) using a three-tier embedding cache: `cold`
(0-9 docs), `warm` (10-49), `hot` (50+). The similarity threshold adjusts
smoothly with corpus size so you don't get precision cliffs as the index grows.

### Free + Pro: token validation that works offline

The Pro token check no longer fails when you're offline. A 24-hour cache
handles normal use, and a 7-day offline grace period covers conference travel,
flights, and spotty hotel Wi-Fi. The background refresh runs via `setImmediate`
so it never blocks a tool call.

---

## What's coming in v1.25

Adaptive thresholds tuned from real telemetry data. The telemetry pipeline
deployed in v1.24 (privacy-preserving, opt-in, SHA-256-folded session IDs,
10 req/min rate limit) will collect a week of real usage. v1.25 will use that
data to tune the `ASHLR_EDIT_MIN_CHARS` guard, the warm-start embedding curve,
and the snip-compact elision parameters — per-language, not one-size-fits-all.

---

## Test counts

2313 plugin tests / 0 fail · 304 server tests / 0 fail.
Typecheck clean (3 pre-existing `serve.ts` errors carry over from main).

---

## Upgrade

```bash
# Claude Code
claude mcp add ashlr -- npx -y ashlr-plugin@latest

# Or update in place
/ashlr-update
```
