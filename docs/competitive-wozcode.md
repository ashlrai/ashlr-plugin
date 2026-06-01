# WozCode Competitive Learnings

> Internal strategy doc — last updated 2026-06-01.
> Source: public site/repo analysis (minified), benchmark pages, pricing docs.
> Treat WozCode's self-reported numbers with skepticism (see Caveats).

---

## Summary

WozCode is a closed-source, account-gated Claude Code efficiency plugin (~182 GitHub stars). It competes directly with Ashlr on token reduction. Their headline claim is "80% token reduction," but their own benchmark pages show internally inconsistent numbers. Ashlr's measured, per-tool savings data is a stronger trust signal.

Three technical capabilities are worth adopting or beating. One pricing model (pay-for-performance) is defensible for Ashlr and worth studying. Several growth surfaces (llms.txt, leaderboard, benchmark blog) are low-effort wins.

---

## Capability Comparison

| Capability | WozCode | Ashlr |
|---|---|---|
| AST-truncated reads (stub bodies, keep signatures) | Yes — default-on for large files | Not yet |
| Fuzzy edit matching (Levenshtein + whitespace tolerance) | Yes | Not yet |
| Post-edit syntax validation loop (Tree-sitter/tsc) | Yes | Not yet |
| Genome / RAG context retrieval | No | Yes |
| Per-tool measured savings | No (aggregate self-report) | Yes |
| Open source + auditable | No (minified, account-gated) | Yes |
| Opt-in telemetry | No (PostHog on-by-default, hardcoded token) | Yes |
| Tool breadth | Narrow (deliberate) | 40 tools, 33 commands |
| `llms.txt` | Yes | No |
| Public savings leaderboard | Yes (gamified) | No |
| Multi-surface install (VS Code / Cursor / Windows) | Yes | macOS/Linux primary |
| Plain-English settings UI (`/woz-settings`) | Yes | Partial (`/ashlr-settings`) |
| Benchmark blog post | Yes | No |

---

## Prioritized Learnings

### P0 — Product (implement to close capability gap)

**1. AST-truncated reads** (highest per-call token win)
WozCode stubs out function bodies on large file reads, returning only signatures, types, and exports. This is their biggest single-call saving. For Ashlr: extend `ashlr__read` to detect large files (>N LOC) and emit an AST-truncated view by default, with `bypassSummary:true` to get full content. Tree-sitter or `@ast-grep/napi` are viable. Make it default-on — users should not need to opt in.

**2. Fuzzy edit matching**
WozCode applies Levenshtein distance + whitespace/unicode normalization before failing an edit. Today Ashlr's `ashlr__edit` fails on whitespace drift, forcing a costly retry round-trip. Adding a fuzzy fallback (with a diff preview so the model can confirm) eliminates that class of second-turn errors entirely.

**3. Post-edit syntax validation loop**
After each edit, WozCode runs a fast syntax check (Tree-sitter for parse errors, `tsc --noEmit` for TypeScript, file-type-appropriate linter) and feeds failures back in the same turn. This prevents bad edits from reaching a second model round-trip. For Ashlr: add an optional `validate: true` flag to `ashlr__edit` / `ashlr__multi_edit` that runs the cheapest applicable checker and returns inline errors.

### P1 — Positioning + Pricing

**Pay-for-performance pricing model**
WozCode Enterprise: `$50/seat + 10% of measured savings`. This is actually *more* defensible for Ashlr than for WozCode because Ashlr's savings are **measured per-tool** (not self-reported aggregate). A pay-for-performance tier aligns incentives perfectly and turns Ashlr's measurement advantage into a pricing advantage. Study structure: base seat fee covers fixed costs; the savings share creates a shared-upside relationship.

**Savings cap on free tier**
WozCode offers a free tier capped at $100/mo in savings rather than feature-gating. This is a better acquisition model than feature-gating: users experience the full product, and heavy users naturally convert. Consider adopting for Ashlr's free tier.

**Lean into WozCode's benchmark inconsistency**
WozCode's TerminalBench numbers differ across their own pages: 80.2%/69% vs 68%/58% vs "17% on their blog." These are internally inconsistent and unverifiable. Ashlr should publish a transparent, reproducible benchmark methodology with per-tool breakdowns — this is already partially done via `benchmarks.md` / `benchmarks-v2.json`. A short benchmark blog post with methodology and raw data is a credibility differentiator.

### P2 — Growth + DX

**`llms.txt`** — Add `site/public/llms.txt` listing Ashlr's tools, commands, and genome format. WozCode has one; it improves AI-driven discovery and is a 30-minute task.

**Public savings leaderboard** — Opt-in leaderboard showing top savers (anonymized or named). WozCode uses this for social proof. Ashlr already collects savings data; surfacing it publicly turns a telemetry feature into a growth loop.

**Benchmark blog post** — A single authoritative post with methodology, per-tool numbers, and comparison. Addresses the credibility gap vs WozCode's (flawed) benchmarks. Publish to the marketing site; link from README and llms.txt.

**Multi-surface install matrix** — Document and test install on VS Code (with MCP), Cursor, Windows (PowerShell). `docs/install-windows.md` and `docs/install.ps1` already exist — surface them more prominently. WozCode's multi-surface presence expands their addressable audience.

**Plain-English settings** — `/ashlr-settings` should describe each setting in one plain sentence with a concrete example. Reduces friction for non-power users.

---

## Where Ashlr Already Wins

Message these proactively in docs, README, and the benchmark blog:

- **Open source + auditable.** WozCode is minified and requires account creation to inspect behavior. Ashlr is fully open — every tool, hook, and genome interaction is readable.
- **Measured savings, not self-reported.** Ashlr tracks per-tool token and cost savings with a verifiable methodology. WozCode's numbers are inconsistent across their own pages.
- **Opt-in telemetry.** WozCode ships PostHog with a hardcoded token, on by default. Ashlr's telemetry is opt-in and documented.
- **Breadth.** 40 tools, 33 commands, genome RAG, `/ashlr-brief`, `/ashlr-efficient`. WozCode's surface is deliberately narrow.
- **No account required.** Ashlr installs with one curl command and one slash command. WozCode requires account creation before the plugin is functional.

---

## Caveats

1. **Benchmark numbers are unverifiable.** All WozCode efficiency claims are self-reported. Their own pages show inconsistent figures (TerminalBench: 80.2/69 vs 68/58 vs "17%"). Do not treat these as ground truth.
2. **Internals are inferred.** The WozCode repo is minified and obfuscated. Technical capabilities above (AST truncation, fuzzy matching, syntax validation) are inferred from public documentation, changelogs, and behavior — not audited source.
3. **Third-party reputation is thin.** 182 GitHub stars, low HN engagement, no independent benchmark reproductions as of 2026-06-01. This is an opening: Ashlr can establish the credibility standard before WozCode does.
4. **Competitive landscape moves fast.** Re-verify these findings before any public messaging; capabilities may have changed.
