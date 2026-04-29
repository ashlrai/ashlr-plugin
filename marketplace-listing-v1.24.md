# Marketplace Listing — ashlr-plugin v1.24

Copy/paste into the Claude Code plugin marketplace UI. Review and trim to
fit character limits before submitting.

---

## Short description (≤ 160 chars)

40-tool token-efficiency layer for Claude Code. -57% mean savings on real
codebases. Cloud sync + hosted summarization for Pro. MIT, zero telemetry.

---

## Full description

ashlr-plugin cuts Claude Code token usage by **-57% cross-language** on real
open-source codebases (TypeScript -62%, Python -65%, Rust -44%) — measured
against vercel/ai, pandas, and tokio, to the byte.

**40 MCP tools** replace native Read, Grep, Edit, MultiEdit, WebSearch, Bash,
and more with lower-token equivalents. All 40 tools now run in a single MCP
process (v1.24 router consolidation), so startup is faster and Claude Code's
tool list is cleaner.

**Free tier ships everything:** 40 tools, 30 skills, the full genome scribe
loop, per-session token ledger, savings benchmark + badge, and automatic
warm-start RAG for small projects — no manual `/ashlr-genome-init` needed.
No account required.

**Pro ($12/mo)** adds:
- Cloud LLM summarizer — no Ollama required for genome summarization
- Cross-machine stats sync — `/ashlr-dashboard` reflects your real history
  across all machines, with a `☁ N machines` status-line badge
- Hosted embedding retrieval — pgvector index refreshed on every push
- Live auto-updating savings badge for your README
- 7-day trial, no card

**Team ($24/user/mo, min 3 seats)** adds shared encrypted team genome
(E2E AES-256-GCM, vclock conflict detection), org savings dashboard, policy
packs, genome diffs on PRs, audit log, and SSO + SCIM.

Supports macOS, Linux, and Windows. All hooks are TypeScript — no bash
required on Windows. MIT-licensed, forkable, benchmarkable.

---

## Tags

`token-efficiency` `mcp` `claude-code` `genome` `open-source` `cost-savings`
`developer-tools` `productivity`

---

## Screenshot suggestions (5)

1. **`/ashlr-dashboard` with cloud badge**
   Caption: "Cross-machine stats sync. `/ashlr-dashboard` shows lifetime
   savings across all machines — `☁ 3 machines` in the status line."
   File needed: `docs/assets/screenshot-dashboard-v1.24-cloud.png`
   <!-- TODO(screenshot): capture after v1.24 deploy with a real Pro account -->

2. **Side-by-side: raw Read vs ashlr__read**
   Caption: "Same file, 5x fewer tokens. snipCompact returns head + tail
   with elided middle and a fidelity footer — no information hiding."
   File needed: `docs/assets/screenshot-before-after-read.png`
   <!-- TODO(screenshot): existing video frame may work; verify it shows v1.24 tool count -->

3. **`/ashlr-savings` output in terminal**
   Caption: "Per-tool ledger at the end of every session. Exact token and
   dollar deltas, not estimates."
   File needed: `docs/assets/screenshot-savings-v1.24.png`
   <!-- TODO(screenshot): re-capture with v1.24 version string visible -->

4. **Benchmark chart: -57% cross-language**
   Caption: "-57% mean across TypeScript, Python, and Rust. Run
   `/ashlr-benchmark` against your own repo to get your number."
   File needed: `docs/assets/screenshot-benchmark-chart.png`
   <!-- TODO(screenshot): export from /ashlr-dashboard benchmark tab -->

5. **Warm-start RAG: first grep returns fast, then indexes**
   Caption: "No manual setup. After the first grep, ashlr indexes your
   corpus in the background. Subsequent searches use vector similarity."
   File needed: `docs/assets/screenshot-warm-start-rag.png`
   <!-- TODO(screenshot): new for v1.24; show ashlr__grep with timing footer -->
