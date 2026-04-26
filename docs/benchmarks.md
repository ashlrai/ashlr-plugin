# ashlr-plugin Token-Savings Benchmarks

> **Latest run:** v1.22.0 (`docs/benchmarks-v2.json`)
> **Headline:** `−74.0%` overall mean token savings on the ashlr-plugin's own repo
> (read `−82.1%`, grep `−92.8%`, edit `−-0.5%` see caveats below)

## How the numbers are produced

`scripts/run-benchmark.ts` measures real byte/token reduction by calling the
handler functions directly — no MCP layer, no Claude Code in the loop. For
each tool, we sample representative inputs from a target repo, run them
through the canonical compression pipeline, and report:

- `rawBytes` / `rawTokens` — what the native tool would have shipped
- `ashlrBytes` / `ashlrTokens` — what the ashlr handler returned
- `ratio` — `ashlrBytes / rawBytes` (lower is better)

The output is a stable JSON shape (`docs/benchmarks-v2.json`) that downstream
tools (dashboard, README badges) can read without re-running the bench.

```bash
# Run against the current repo
bun run scripts/run-benchmark.ts

# Run against another repo (must be a git checkout)
bun run scripts/run-benchmark.ts --repo /path/to/other-repo --out /tmp/other.json

# Dry-run: print results, don't write JSON
bun run scripts/run-benchmark.ts --dry-run
```

## What the headline number actually means

`overall.mean = arithmetic mean of all sample ratios across read/grep/edit.`

This is **a specific number for a specific repo and a specific tool mix**.
It is NOT a marketing estimate; it is what the compression layer measured on
actual files. Three things shape it:

1. **File mix.** A repo full of large source files (well-suited to read
   compression) will show higher savings than a repo full of media or
   generated artifacts. The ashlr-plugin's own repo includes `hero.mp4`,
   `bench/refs/`, `docs/benchmarks-v2.json` itself (large) — these drag
   `ashlr__read` mean savings down vs a typical user codebase.

2. **Tool mix.** Read and grep typically save 80-95%. Edit savings depend on
   *where* the edit lives:
   - Small edits (≤ 80 chars combined old+new) skip the redirect entirely
     in real use (Track A `ASHLR_EDIT_MIN_CHARS` guard) — but the bench
     calls handlers directly and so reports the negative-savings the guard
     prevents in practice. Treat the edit headline as a ceiling for
     "redirect-eligible edits," not a typical-user number.
   - Medium edits (20-200 LOC range) save ~50%.
   - Large edits (> 200 LOC) save 90%+.

3. **Workload shape.** A user who reads many files but edits few will see
   higher savings than a user who edits constantly with small touches.

## Per-tool savings (v1.22 measured 2026-04-25)

| Tool                | Mean savings | Notes |
|---------------------|--------------|-------|
| `ashlr__read`       | **−82.1%**  | snipCompact head/tail + LLM summarization for >16KB files |
| `ashlr__grep`       | **−92.8%**  | Genome-RAG when available; ripgrep-summarize fallback |
| `ashlr__edit`       | **~0%** raw bench | But hook now skips micro-edits below `ASHLR_EDIT_MIN_CHARS=80`, so real-world is ≥0 |
| `ashlr__multi_edit` | not in bench | Track B baseline fix (v1.22) — was 5-10× over-credited |
| `ashlr__websearch`  | not in bench | Estimated 60-80% (per fixture inspection) |
| `ashlr__task_list`  | not in bench | Estimated 70-85% (per fixture inspection) |
| `ashlr__notebook_edit` | not in bench | Estimated 65-75% on multi-cell notebooks |
| `ashlr__write`      | not in bench | Identical to `ashlr__edit` for existing files |

**v1.23 work**: extend `scripts/run-benchmark.ts` to include the new tool
families using `bench/fixtures/{websearch,tasklist,notebook}-*.{json,ipynb}`
+ a curated multi-repo reference set (Node SDK, Python lib, Rust project).

## Reproducing the numbers

The bench is deterministic given a repo + commit SHA. To verify a number:

```bash
git checkout <sha>          # the commit you want to reproduce
bun install
bun run scripts/run-benchmark.ts --dry-run
```

The bench seeds its file sampler with the commit SHA (when run in a clean
checkout) so two people on the same SHA get the same sample set.

## Why no aggregate cross-repo headline yet

The plan called for a curated 3-repo reference set (TS / Python / Rust).
This requires either committing 3 repo subsets to the plugin (large) or a
download script with stable revisions. v1.22 ships the per-repo bench
infrastructure; v1.23 will add the multi-repo aggregator and a single
defensible cross-repo headline.

Until then: **quote per-repo numbers**. If you want a headline for your own
codebase, run the bench locally — it takes ~2 minutes.

## Trust pass — what `v1.22` fixed in the math

Per the v1.22 audit (`~/.claude/plans/ultrathink-deploy-agents-to-jazzy-hoare.md`),
four bugs distorted reported savings prior to this release:

1. **Edit micro-edit penalty.** Sub-80-char edits on >5KB files were
   redirected through the diff round-trip and produced *negative* savings
   (~−150% at p90 in `docs/benchmarks-v2.json`). Track A added an
   `ASHLR_EDIT_MIN_CHARS` guard that passes those through to native Edit.

2. **Multi-edit baseline inflation.** `ashlr__multi_edit` baseline was
   `original.length + updated.length` per file (full file twice) — the
   pre-v1.18 formula. Track A aligned it with single-edit:
   `Σ hunk.search.length + hunk.replace.length`. Removed 5-10× over-credit.

3. **Pricing map.** Default model was `sonnet-4.5` ($3/MTok). Track A
   added `sonnet-4.6` ($2.5) as new default plus `opus-4.7` ($18 in / $90 out).
   Opus users were under-priced ~2× before.

4. **`tool_noop` mislabeling.** Low-confidence paths emitted `tool_noop`
   events even when content WAS shipped. Track A renamed to
   `tool_low_confidence_shipped` so the savings-accounting signal is
   accurate. `tool_noop` now reserved for actual zero-bytes-shipped no-ops.

## Telemetry that grounds the bench in real usage

v1.22 Track G adds dashboard sections that show real-world data:

- **"Where savings come from"** — per-mechanism breakdown
  (snipCompact / LLM-anthropic / LLM-onnx / LLM-local / genome / embed-cache /
  structured-render).
- **"Adoption funnel"** — blocks emitted vs blocks → ashlr-call rate (7-day
  rolling). Run `/ashlr-dashboard` to see it.
- **`/ashlr-status`** — LLM provider availability + embed-cache hit rate +
  genome fire-rate + 24h block→ashlr-call ratio.

These are the numbers worth tracking weekly. The bench is a calibration
tool; the telemetry is the live feedback loop.
