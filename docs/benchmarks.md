# ashlr-plugin Token-Savings Benchmarks

For a guide to the workload, aggregation, and interpretation, see the
[benchmark methodology guide](benchmark-methodology-guide.md).
For the fixed grep workload's Rust limitations, see
[Rust patterns in the token-savings benchmark](benchmark-rust-patterns.md).
For a concise explanation, see the [Rust match-rate caveat](benchmark-rust-pattern-caveat.md).
For a concrete example and interpretation caveats, see
[Rust grep pattern caveats](benchmark-rust-pattern-caveats.md).
For how pattern selection affects comparisons and what the saved data records,
see [benchmark pattern selection](benchmark-pattern-selection.md).
For a pattern-by-pattern language map, see
[benchmark pattern language map](benchmark-pattern-language-map.md).
For a concise guide to reading grep results, see
[benchmark grep interpretation](benchmark-grep-interpretation.md).
For the exact search strings, see the [grep pattern list](benchmark-grep-pattern-list.md).
For questions about language coverage and match rates, see
[grep benchmark coverage questions](grep-benchmark-coverage-questions.md).

> **Latest run:** 2026-10-17 (`docs/benchmarks-v2.json`)
> **Headline:** per-call figures only: reads about `−75%`, greps about `−27%` (not end-to-end; the `−60%` cross-language mean below is a per-call mean, not total session savings)
> (TS/vercel-ai `−60%`, Python/pandas `−63%`, Rust/tokio `−55%`)
>
> _Prior self-repo figure (`−74%`) is preserved in `docs/benchmarks-v2.json`
> under `aggregate.overall.mean` but is no longer the headline — it reflects
> the plugin's own repo which includes large generated JSON and media files._

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

## Per-tool savings (measured 2026-04-26)

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

**Future work**: extend `scripts/run-benchmark.ts` to include the new tool
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

## Multi-repo reference set

### Why a multi-repo headline?

The ashlr-plugin's own repo contains `hero.mp4`, large generated JSON
(`docs/benchmarks-v2.json`), the `.ashlrcode/genome/` knowledge base, and
`site/tsconfig.tsbuildinfo`. These files make the self-repo benchmark
non-representative — they inflate `ashlr__read` savings beyond what a typical
user codebase would see.

### The three reference repos

| Key | Language | Upstream | Sampled commit | Files |
|-----|----------|----------|----------------|-------|
| `node-sdk` | TypeScript | [vercel/ai](https://github.com/vercel/ai) | `0498012` | 32 TS files from `packages/ai/src/` |
| `python-lib` | Python | [pandas-dev/pandas](https://github.com/pandas-dev/pandas) | `be0642f` | 30 Py files from `pandas/core/` |
| `rust-project` | Rust | [tokio-rs/tokio](https://github.com/tokio-rs/tokio) | `6c03e03` | 31 Rs files from `tokio/src/` |

Each ref directory lives in `bench/refs/<key>/` and is itself a git repo.
A `.refrev` file records the upstream commit SHA sampled from.

**Why these three?** TypeScript + Python + Rust are the top three languages in
the ashlr-plugin user base (based on install telemetry). Each project is a
well-maintained OSS library with realistic file size distributions: small
utilities, medium modules, and large implementation files. They collectively
represent agentic AI SDK code, data-science library internals, and systems
async runtime code — meaningfully different workloads.

### Results (measured 2026-10-17)

| Repo | Overall | Read | Grep | Edit |
|------|---------|------|------|------|
| `node-sdk` (TS) | **−60.0%** | −74.9% | −30.4% | −49.5%* |
| `python-lib` (Py) | **−63.3%** | −73.9% | −39.1% | −49.5%* |
| `rust-project` (Rs) | **−55.3%** | −74.4% | −12.2% | −49.5%* |
| **Cross-language mean** | **−60%** | **−74%** | **−27%** | −49.5%* |

_*Edit figures come from the same three synthetic edits in every repo (see
the edit caveat above), so they do not vary by language._

**Grep baseline (changed 2026-10-17):** the raw side is plain `rg -n` output
(`path:line:text`, what a native grep returns). Earlier runs measured against
`rg --json`, which is about three times larger for the same matches, and
reported greps at about −50%. The fallback now returns complete
`path:line:text` lines instead of a cut-down JSON stream.

**Grep patterns:** the runner uses these same five search strings for every
repo. The four strings other than `TODO` include a trailing space:

```json
["function ", "import ", "TODO", "class ", "interface "]
```

**Note on grep for Rust:** Rust uses `use` for imports, `fn` for functions,
and structs, enums, and traits rather than `class` or `interface` keywords.
These patterns may therefore match only incidental text such as comments and
have low match rates. `TODO` can match Rust comments, but its frequency
depends on the repo. For example,
`rg -n 'use ' bench/refs/rust-project` searches for a common Rust import
construct; it is an illustrative alternative, not a measured pattern in the
table.

Few matches often produce a short result, leaving less output for the fallback
to truncate and therefore less measured savings. For a concrete Rust-oriented
example, the [benchmark test](../__tests__/run-benchmark.test.ts) uses a Rust
file with `use`, `fn`, and one `TODO`: only `TODO` produces a sample, and its
short output has no savings. A pattern with no matches produces no grep
sample; it is not counted as zero savings. The grep mean is an equal-weighted
mean of the remaining sample ratios, so pattern selection and match volume
affect comparisons between repos. If no patterns produce a sample, the grep
aggregate defaults to a ratio of 1 (0% savings); that is a fallback, not a
measurement. The Rust figure describes this workload; it does not predict
savings for Rust-idiomatic searches. The genome-RAG path is not measured here.

**Interpreting match counts:** The number of matching patterns indicates how
much of this fixed pattern set contributes samples; the number of matches per
pattern shapes the output available to compress. Neither establishes how
completely the patterns cover a language or how fast a search runs. A repo
with fewer matching patterns can have a different grep mean and a different
grep weight in the pooled overall mean, even before comparing the resulting
ratios. These benchmarks report output-size savings, not elapsed time or
search throughput. Compare languages with the patterns, match counts, and
sample counts in mind; use representative language-specific searches and
separate timing measurements to assess those other questions.

### How the aggregate is computed

`crossLanguageMean = arithmetic mean of the 3 repo overall.mean values`

The per-repo mean is itself the pooled mean across all individual read/grep/edit
sample ratios (same as the per-repo bench). See `scripts/benchmark-refs.ts` for
the exact computation.

### Running the multi-repo bench yourself

```bash
# Run all three ref repos and merge into docs/benchmarks-v2.json
bun run scripts/benchmark-refs.ts

# Dry run (no file write)
bun run scripts/benchmark-refs.ts --dry-run

# Write to a different output path
bun run scripts/benchmark-refs.ts --out /tmp/my-bench.json
```

### Extending with your own repo

You can add your own codebase to the reference set:

1. Create a directory under `bench/refs/<your-key>/` and populate it with
   source files (must be a git checkout — `git init && git add . && git commit`).
2. Add a `.refrev` file with the upstream commit SHA.
3. Add your config to the `REFS` array in `scripts/benchmark-refs.ts`.

The bench uses `git ls-files` to enumerate tracked files, so you control
exactly which files are measured by what you commit to the ref repo.

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

## Note: line numbers add overhead on very small files

Reads of code files keep line numbers by default so edits and references stay precise. On very small files the line-number prefix can cost more than the compaction saves. No committed benchmark measures this yet: as a rough byte count (not tokens), the `N: ` prefix adds about 13% to files under 1.7 KB at main a0f656b. Pass `preserveLineNumbers: false` to `ashlr__read` to get the file without line numbers; the default is unchanged.

## Related bench: orchestrator overhead is stub-only (no real LLM calls)

The tables above measure token savings. A separate benchmark,
`scripts/bench-orchestrate.ts`, measures local wall-clock time for `runTaskGraph`
across five synthetic DAG shapes (chain-3, chain-10, wide-3, wide-10,
diamond). Each node spawns a tiny `bun --eval` stub subprocess. The result
includes spawn, IPC, scheduling, and persistence work; it is not an isolated
scheduler measurement.

The benchmark is stub-only and refuses to run when
`ASHLR_ORCHESTRATE_REAL_LLM=1` is set. Its local reference cannot establish a
universal floor for the different real-LLM executor, or predict provider
latency, cost, quality, and speedup on non-trivial real workloads. In
particular, the script's >100ms API-call comment is not a measurement or a
guarantee. See the [interpretation guide](orchestrate-benchmark-interpretation.md)
for the reported statistics and how to compare runs.
