# Launch Tweet Thread — ashlr-plugin v1.24

Draft for review. Numbers sourced from CHANGELOG.md and benchmarks-v2.json.
Adjust handle, link, and tone before posting.

---

**Tweet 1 — hook**

We've been measuring Claude Code token waste for months.

-62% on TypeScript. -65% on Python. -44% on Rust.

40 MCP tools. One plugin. Free and MIT.

ashlr v1.24 just shipped.

🧵

---

**Tweet 2 — what it does**

ashlr intercepts every Claude Code call that's worth compressing — Read, Grep,
Edit, WebSearch, Bash — and returns the same answer in fewer tokens.

Not a summary. Not a lossy approximation. A snipCompact view: head + tail,
elided middle, fidelity footer so you know what was cut.

No magic. Just math.

---

**Tweet 3 — v1.24: router consolidation (Free)**

v1.24 ships one MCP process for all 40 tools (was N child processes).

Faster cold start. Cleaner tool list. Backwards-compatible — existing
multi-MCP configs still work via legacy entrypoints.

Free tier. No account needed.

---

**Tweet 4 — v1.24: warm-start RAG (Free)**

Small projects now get automatic vector search — no `/ashlr-genome-init`.

After the first grep returns, ashlr indexes your corpus in the background.
Three-tier cache (cold / warm / hot) with a smooth similarity threshold
so precision doesn't fall off a cliff as your index grows.

Free. No Ollama required.

---

**Tweet 5 — v1.24: cloud sync (Pro)**

Pro users: your savings ledger now syncs across machines.

Push on session end. Pull on session start. `/ashlr-dashboard` shows
lifetime totals with a `☁ N machines` badge.

No export. No SSH. Just works.

Pro is $12/mo. 7-day trial, no card.

---

**Tweet 6 — v1.24: hosted summarization (Pro)**

Also for Pro: genome summarization now runs on hosted infrastructure.

No Ollama. No local LLM. 5s timeout, SHA-256 cache, automatic fallback to
ONNX or local LM Studio if the cloud is unavailable.

If you installed Ollama just for ashlr, you can uninstall it.

---

**Tweet 7 — what's next**

v1.25: adaptive thresholds tuned from real telemetry data.

The telemetry pipeline in v1.24 is privacy-preserving (opt-in, SHA-256
session IDs, 10 req/min). After a week of real data, v1.25 will tune the
compression parameters per-language.

-57% is the floor. v1.25 will push it further.

---

**Tweet 8 — CTA**

Install in 30 seconds:

```
claude mcp add ashlr -- npx -y ashlr-plugin
```

Then:
```
/ashlr-allow   ← stop the permission prompts
/ashlr-savings ← see what you saved this session
```

Landing page + docs: plugin.ashlr.ai
GitHub (MIT): github.com/ashlrai/ashlr-plugin
