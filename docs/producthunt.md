# ProductHunt Launch Draft

## Tagline (60 char max)

```
Open-source Codex + Claude Code token ledger.
```
(50 chars)

## Description (260 char max)

```
ashlr replaces high-volume Read/Grep/Edit/Bash workflows with compressed alternatives for Codex and Claude Code. 40 MCP tools, Codex skills, measured −57% token savings on real codebases. MIT free forever.
```
(205 chars)

---

## First comment (from the maker)

I started building ashlr in April after watching Claude Code blow through a context window on what should have been a simple refactor. The culprit was obvious once I looked: every native Read call was shipping the full file — 10,000 tokens for a file I needed three lines from.

v0.6 was a rough proof of concept: three MCP tools, a basic snip-compactor, a status line that mostly worked. The numbers were promising but not measured — I was estimating savings, not counting them.

Between v0.6 and v1.36 I built out the full accounting layer: per-session token ledger, Codex-native plugin packaging, an animated Claude Code status line, a genome-aware grep path that uses retrieval, and a reproducible cross-repo benchmark. The honest −57% number comes from TypeScript, Python, and Rust reference repos — including workloads where the plugin is less flattering than a single self-repo benchmark. I kept those caveats in because the methodology has to be auditable.

A few things broke along the way that are worth being honest about. The session counter showed `+0` for weeks because Claude Code doesn't forward CLAUDE_SESSION_ID into MCP subprocesses. The `$` interpolation bug silently corrupted multi-edits containing template literals. An unrelated zombie-process issue made `/reload-plugins` look like it worked when it didn't. All three are fixed in the changelog with root causes.

860 tests pass. 2 are skipped for documented reasons. The benchmark runs weekly in CI.

If you use Claude Code on a real codebase, install the free tier and run `/ashlr-benchmark`. The number will either justify itself or it won't — either way it's your number, not mine.

Feedback welcome, especially on the genome-init workflow and anything that looks wrong about the benchmark methodology.

---

## Gallery captions (5 items)

1. **Status line in action**
   Terminal screenshot showing `ashlr · 7d ▁▂▃▅▇█ · session ↑+48.2K · lifetime +2.1M` with the animated gradient sweep and activity pulse indicator. Run `/ashlr-savings` to reproduce.

2. **ASCII dashboard**
   Terminal screenshot of `/ashlr-dashboard` — three CountUp tiles (session / lifetime / best day), per-tool horizontal bar chart, 7-day and 30-day sparklines, projected annual savings. Run `/ashlr-dashboard` on any active session.

3. **Benchmarks page**
   Browser screenshot of `plugin.ashlr.ai/benchmarks` showing the −57% cross-language number, per-language breakdown, and the methodology panel. Numbers are reproducible from the repo.

4. **Before / after token comparison**
   Side-by-side showing the same `ashlr__read` call: raw file (10,846 bytes / 2,709 tokens) vs ashlr output (1,623 bytes / 406 tokens). The 85% reduction on `server/tests/auth.test.ts` from `docs/benchmarks-v2.json`.

5. **Pricing**
   Browser screenshot of `plugin.ashlr.ai/pricing` — three-tier layout (Free / Pro / Team) with the feature comparison table. Emphasizes the free tier is not crippled.
