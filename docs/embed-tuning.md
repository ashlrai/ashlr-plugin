# Embedding Cache Threshold Tuning

The ashlr grep cache uses cosine similarity to decide whether a cached result
is close enough to the current query to be reused. The default threshold is
`0.68`. This document explains how to tune it for your actual usage patterns.

## Background

Every grep routed through `ashlr__grep` logs a calibration record to
`~/.ashlr/embed-calibration.jsonl`:

```jsonl
{"ts":"2026-04-25T10:00:00Z","queryHashHex":"a1b2c3d4","topSimilarity":0.82,"hit":true,"contentLength":1400,"threshold":0.68}
{"ts":"2026-04-25T10:00:01Z","queryHashHex":"e5f6a7b8","topSimilarity":0.61,"hit":false,"contentLength":0,"threshold":0.68}
```

- `hit: true` — the cached result was served (cosine similarity >= threshold).
- `hit: false` — the cache was skipped; a fresh ripgrep ran instead.
- `topSimilarity` — the best cosine score found in the embedding index.

After a few hundred grep operations you have enough data to tune the threshold.

## Running the tuner

```sh
# Report only (no changes written):
bun run scripts/embed-tune.ts

# Custom input file:
bun run scripts/embed-tune.ts --input ~/.ashlr/embed-calibration.jsonl

# Weight precision 2× over recall (penalise false positives harder):
bun run scripts/embed-tune.ts --weight precision=2

# Write recommendation to ~/.ashlr/config.json:
bun run scripts/embed-tune.ts --apply
```

Sample output:

```
ashlr embed-tune report
──────────────────────────────────────────────────
  entries analysed : 312
  beta weight      : 1 (F1 score)

  current threshold  0.68  →  precision 0.74  recall 0.83  F1 0.78
  recommended        0.71  →  precision 0.81  recall 0.79  F1 0.80

  Set via: ASHLR_EMBED_THRESHOLD=0.71
  Or run with --apply to persist to ~/.ashlr/config.json
```

## How it works

The tuner sweeps thresholds from `0.50` to `0.95` in `0.01` steps. At each
step it computes:

| Metric    | Definition |
|-----------|------------|
| precision | % of cache hits that were genuine (hit=true in calibration data) |
| recall    | % of all genuine hits that would still be served from cache |
| F1        | harmonic mean of precision and recall |

The threshold that maximises F1 (or F-beta with `--weight`) is recommended.

### Weighted F-beta

Pass `--weight precision=2` to use F2, which weights recall twice as much as
precision — useful if you want maximum cache utilisation and can tolerate some
irrelevant results. Pass `--weight precision=0.5` (i.e. F0.5) to prioritise
precision — useful if false positives cause visible quality regressions.

## Applying the result

With `--apply`, the tuner writes `embedThreshold` to `~/.ashlr/config.json`:

```json
{
  "embedThreshold": 0.71
}
```

Then prints: **"Restart Claude Code to apply."**

The MCP server reads this value on startup. The `ASHLR_EMBED_THRESHOLD`
environment variable takes precedence over `config.json` when both are set.

## Minimum corpus size

The embedding cache is skipped entirely when the BM25 corpus has fewer than
50 documents (`BM25_CORPUS_MIN`). Below this size, IDF weights are noisy and
cosine similarity scores are unreliable regardless of threshold. Let the corpus
grow before tuning.

## When to re-tune

- After onboarding a new large project (corpus distribution shifts).
- If you change the embedding model (`ASHLR_EMBED_MODEL`).
- If you notice grep results that look stale or irrelevant.

A rule of thumb: re-tune after every ~500 grep operations, or whenever
`embed-calibration.jsonl` grows by more than 200 lines since the last run.
