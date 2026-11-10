# Fact sheet — ashlr-plugin

Quick-reference for journalists and analysts.

---

| Field | Value |
|---|---|
| **Product name** | ashlr-plugin |
| **Current version** | 1.38.7 |
| **Release date** | November 2026 |
| **Repository** | github.com/ashlrai/ashlr-plugin |
| **License** | MIT |
| **Website** | plugin.ashlr.ai |
| **Category** | Codex plugin / Claude Code plugin / AI coding tool / MCP server |
| **Primary use case** | Token-efficiency layer for Codex and Claude Code |

---

## Technical

| Field | Value |
|---|---|
| **MCP tools** | 54 |
| **Skills / slash commands** | 37 Claude Code slash commands + Codex workflow skills |
| **Codebase (plugin repo)** | 1,294 files, 277,392 LOC in the latest self-repo benchmark artifact |
| **Runtime** | Bun >= 1.3 |
| **Benchmark: overall savings** | about −60% cross-language per-call mean token reduction |
| **Benchmark: read savings** | about −75% per call |
| **Benchmark: grep savings** | about −27% per call |
| **Benchmark methodology** | scripts/run-benchmark.ts; daily CI run; docs/benchmarks-v2.json |
| **Compatible hosts** | Codex, Claude Code, Cursor (via MCP), Goose (via recipe), generic MCP hosts |

---

## Team

| Field | Value |
|---|---|
| **Team size** | 1 (solo founder) |
| **Founder** | Mason Wyatt |
| **Contact** | support@ashlr.ai |
| **Press contact** | support@ashlr.ai |

---

## Pricing

| Tier | Price | Notes |
|---|---|---|
| Free | $0 forever | Full plugin, MIT, no feature gates |
| Pro | $12/month or $120/year | Cloud genome sync, hosted LLM summarizer, cross-machine stats |
| Team | $24/user/month or $20/user/month annual (min 3 users) | E2E-encrypted shared team genome (vclock LWW + manual conflict resolution), org dashboard, policy packs, SSO, audit log |
| Enterprise | Contact sales | On-prem, private inference, dedicated SLA |

---

## Key claims (all traceable)

| Claim | Source |
|---|---|
| about −60% cross-language per-call token savings | docs/benchmarks.md, multi-repo reference set |
| reads about −75% per call | docs/benchmarks.md headline; cross-language read column −74% |
| greps about −27% per call | docs/benchmarks.md headline; cross-language grep column −27% |
| 54 MCP tools | `ashlr-plugin tools --json` / servers/_tool-catalog.json |
| 37 slash commands + Codex skills | commands/ashlr-*.md + docs/pricing.md |
| MIT license | LICENSE file |

---

## Known limitations

- MCP-wiring tests spawn real server processes with a 5 s cap; on a heavily loaded machine a fraction time out under the parallel runner and pass in isolation.
- `rg` binary sensitivity: benchmark rg-resolution walks multiple candidate paths but may require `rg` to be a plain system binary in some environments.
- Small edits (< ~30 chars): `ashlr__edit` diff-summary overhead exceeds naive payload; ratio is 2.5x in the small-edit benchmark bucket.
