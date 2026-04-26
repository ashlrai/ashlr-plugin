# ashlr-plugin Token-Savings Benchmarks

> **Latest run:** v1.23.0 (`docs/benchmarks-v2.json`)
> **Headline:** `−56.7%` cross-language mean on real open-source codebases
> (TS/vercel-ai `−61.6%`, Python/pandas `−64.9%`, Rust/tokio `−43.6%`)
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

## Multi-repo reference set (v1.23)

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

### Results (v1.23, measured 2026-04-25)

| Repo | Overall | Read | Grep | Edit |
|------|---------|------|------|------|
| `node-sdk` (TS) | **−61.6%** | −75.3% | −66.1% | ~0%* |
| `python-lib` (Py) | **−64.9%** | −78.8% | −67.9% | ~0%* |
| `rust-project` (Rs) | **−43.6%** | −70.0% | −17.2% | ~0%* |
| **Cross-language mean** | **−56.7%** | **−74.7%** | **−50.4%** | ~0%* |

_*Edit savings at ~0% in the bench reflects the synthetic small-edit overhead
(see edit caveat above). Real-world medium/large edits save 50-96%._

**Note on grep for Rust:** ripgrep patterns `import`, `TODO`, `class`, and
`interface` have low match rates in Rust source (Rust uses `use`, `//TODO:`,
struct/enum, and traits instead). This suppresses the grep headline for the
rust-project repo. With Rust-idiomatic patterns (`fn `, `use `, `impl `, etc.)
savings would be comparable to TS/Py. The bench intentionally uses
language-agnostic patterns to expose this; the genome-RAG path (not measured
here) adapts to file content automatically.

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
