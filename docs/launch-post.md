# Why I built a token-efficiency layer for Claude Code

Token counts are a real operating cost. I started noticing it the same way you notice a slow memory leak: not all at once, but through accumulating evidence. The context window fills up faster than it should. Sessions hit the limit mid-refactor. The Anthropic invoice climbs past what feels proportionate to the actual work done.

The culprit is usually reads. When Claude Code opens a 15,000-token file to change three lines, it ships all 15,000 tokens to the model as context. Grep a large codebase for an import pattern and you might get 85,000 tokens of match output that the model skims and discards. Every native `Read`, `Grep`, and `Edit` call transmits the full payload whether the model needs it or not.

That is the problem ashlr solves.

---

## What it is

ashlr is an open-source Claude Code plugin: 17 MCP tools, 25 skills, an animated status line, and an optional hosted backend. One-line install:

```bash
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

The tools replace Claude Code's native `Read`, `Grep`, and `Edit` with compressed alternatives. `ashlr__read` returns a head+tail snip instead of the full file. `ashlr__grep` routes through a genome-aware retrieval index when one exists, and falls back to truncated ripgrep otherwise. `ashlr__edit` returns a diff summary instead of echoing the full before+after. The model gets enough context to do the work. The bill shrinks.

---

## Why now

Two things converged. Claude Code added a first-class plugin system with MCP support, which means tools like this can run as standard MCP servers under any compatible host — Cursor and Goose ports ship with the plugin today. And AI coding costs have matured from "toy" to "line item." Teams running Claude Code across five engineers with heavy usage are spending real money. The efficiency question is no longer academic.

---

## The moment it clicked

I was working in this repo — the ashlr-plugin codebase itself, 337 files, 56,901 lines — and ran a benchmark to see what the numbers actually looked like. Not rough estimates. Measured, reproducible numbers against real files.

Here is what the benchmark found on `ashlr__read` for a 15KB test file (`server/tests/auth.test.ts`, 10,846 bytes):

| | Raw | ashlr |
|---|---|---|
| Bytes | 10,846 | 1,623 |
| Tokens | 2,709 | 406 |
| Ratio | 1.00 | 0.15 |

That is an 85% reduction on one file. For the `CHANGELOG.md` (41,100 bytes, 10,200 raw tokens), the ratio drops to 0.040 — the compressed view uses 406 tokens where the full file would have used 10,200. The model gets the structural information it needs; the padding disappears.

Across all file sizes in the benchmark:

| Tool | Mean savings | p50 savings |
|---|---|---|
| `ashlr__read` | −82.2% | −88.8% |
| `ashlr__grep` | −81.7% | −97.2% |
| **Overall** | **−71.3%** | — |

The overall −71.3% is the honest number: it includes small edits where `ashlr__edit` is larger than naive (the diff-summary overhead exceeds the edit payload when the edit is three characters). Medium and large edits compress by 52% and 96.5% respectively. The benchmark methodology is published in `docs/benchmarks-v2.json` and reproduced weekly by a CI job.

---

## What's free, what's paid

Everything in the free tier is the product. 17 MCP tools, 25 skills, the genome scribe loop, per-session token accounting, a calibration harness, a reproducible benchmark. MIT license. No account. No telemetry.

Pro ($12/month or $120/year) adds hosted infrastructure for developers who need it: a cloud LLM summarizer so you do not need Ollama running locally, cross-machine stats sync, a live auto-updating badge. It does not remove or degrade anything in the free tier.

Team ($24/user/month) adds the shared encrypted team genome — one authoritative retrieval index per repo, end-to-end encrypted with AES-256-GCM and synced via vclock-based last-write-wins (concurrent edits surface in `/ashlr-genome-conflicts` for a one-click manual resolve) — plus org dashboards, policy packs, genome diffs on PRs, SSO, and audit log.

Enterprise covers on-prem deployment with private inference. Nothing about the free tier is crippled to push upgrades.

---

## Who it's for

Individual developers today. If you use Claude Code heavily on real codebases, the free tier will measurably reduce your token consumption within the first session. Run `/ashlr-benchmark` against your own repo and read the number.

Teams via pro. The shared genome becomes worth the overhead at three or more engineers working the same codebase — the retrieval index reflects everyone's edits, not just yours.

Enterprise via on-prem. If your company is sensitive about code leaving the VPC, the plugin's architecture supports private inference endpoints. The genome format is a public spec; nothing is locked to the hosted service.

---

## Three things that surprised me building this

**The session counter bug (v0.9.3).** The status line was showing `session +0` for many users even as lifetime totals kept climbing. The cause was subtle: Claude Code forwards `CLAUDE_SESSION_ID` to hooks but not to MCP server subprocesses. So the MCP server was writing savings to a PPID-hash bucket, and the status line was reading a `CLAUDE_SESSION_ID` bucket, and the two never intersected. The fix — `candidateSessionIds()` returning both and aggregating across them — sounds obvious in retrospect but required actually inspecting a live `stats.json` to see the orphaned bucket sitting there with 2,863 tokens that nobody was reading.

**The `$` interpolation bug (v0.9.2).** `ashlr__multi_edit` uses `String.prototype.replace()` for strict-mode edits. JavaScript's `replace(string, string)` interprets `$&`, `$1`, `` $` ``, and `$'` in the replacement string. This silently corrupted any edit whose replacement contained a `$` followed by certain characters — template literals, TypeScript generic constraints, currency strings. The fix was switching to `slice + concat`, which treats the replacement as a literal. The bug had been there since the tool launched; the security audit in v0.9.2 caught it.

**Zombie processes (v1.0.1).** Running `/reload-plugins` in Claude Code re-reads plugin manifests but does not kill MCP server subprocesses spawned by earlier reloads. If a terminal was opened before an upgrade, the old MCP server process keeps writing the old stats.json schema alongside the new writers. The v1 and v2 shapes are incompatible enough that the v1 writer was periodically wiping the `sessions` map that the v2 reader depended on. The fix was a fallback in `pickSession()` that surfaces the v1 singular counter when the v2 sessions map is empty. Full correctness requires restarting Claude Code, not just reloading plugins.

---

## Open source

The full plugin — every tool, every skill, the genome format, the compression logic — is on GitHub at [github.com/ashlrai/ashlr-plugin](https://github.com/ashlrai/ashlr-plugin). The benchmark script is `scripts/run-benchmark.ts` and the seeded results are in `docs/benchmarks-v2.json`. The CI job at `.github/workflows/ci.yml` runs it on every push and opens a PR on Monday to refresh the data.

860 tests pass. 2 are skipped: a `no-genome grep` flake that only surfaces in the full-suite parallel environment (passes reliably in isolation) and a benchmark ratio assertion with the same root cause. Both are documented in-line.

---

## Install

```bash
curl -fsSL plugin.ashlr.ai/install.sh | bash
```

Then inside Claude Code:

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

Restart Claude Code. Run `/ashlr-allow` once to silence permission prompts. Run `/ashlr-tour` for a 60-second walkthrough on your actual codebase.

Full docs at [plugin.ashlr.ai/docs](https://plugin.ashlr.ai/docs). Pricing at [plugin.ashlr.ai/pricing](https://plugin.ashlr.ai/pricing).

If the numbers look wrong on your codebase, run `/ashlr-benchmark` and open an issue. The methodology is public and the script is auditable.
