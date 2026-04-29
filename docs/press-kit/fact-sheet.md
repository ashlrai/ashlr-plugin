# Fact sheet — ashlr-plugin

Quick-reference for journalists and analysts.

---

| Field | Value |
|---|---|
| **Product name** | ashlr-plugin |
| **Current version** | 1.4.0 |
| **Release date** | April 18, 2026 |
| **Repository** | github.com/ashlrai/ashlr-plugin |
| **License** | MIT |
| **Website** | plugin.ashlr.ai |
| **Category** | Claude Code plugin / AI coding tool / MCP server |
| **Primary use case** | Token-efficiency layer for Claude Code |

---

## Technical

| Field | Value |
|---|---|
| **MCP tools** | 17 |
| **Skills (slash commands)** | 25 |
| **Test count** | 860 pass, 2 skip, 0 fail |
| **Test files** | 55 |
| **Codebase (plugin repo)** | 337 files, 56,901 LOC |
| **Runtime** | Bun >= 1.3 |
| **Benchmark: overall savings** | −71.3% mean token reduction |
| **Benchmark: read savings** | −82.2% mean |
| **Benchmark: grep savings** | −81.7% mean |
| **Benchmark methodology** | scripts/run-benchmark.ts; weekly CI refresh; docs/benchmarks-v2.json |
| **Compatible hosts** | Claude Code, Cursor (via MCP), Goose (via recipe) |

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
| −71.3% overall token savings | docs/benchmarks-v2.json, aggregate.overall.mean = 0.287 → 1 − 0.287 = 71.3% |
| −82.2% read savings | docs/benchmarks-v2.json, aggregate.ashlr__read.mean = 0.178 → 1 − 0.178 = 82.2% |
| −81.7% grep savings | docs/benchmarks-v2.json, aggregate.ashlr__grep.mean = 0.183 → 1 − 0.183 = 81.7% |
| 860 passing tests | CHANGELOG.md [1.4.0] Tests section |
| 17 MCP tools | README.md tool table |
| 25 skills | docs/pricing.md + CHANGELOG.md [1.3.0] |
| MIT license | LICENSE file |

---

## Known limitations

- 2 tests skipped: `no-genome grep` environment-leak flake and a benchmark ratio assertion (same root cause). Both pass in isolation; documented in-line.
- `rg` binary sensitivity: benchmark rg-resolution walks multiple candidate paths but may require `rg` to be a plain system binary in some environments.
- Small edits (< ~30 chars): `ashlr__edit` diff-summary overhead exceeds naive payload; ratio is 2.5x in the small-edit benchmark bucket.
