# Genome Auto-Refresh

The genome (`.ashlrcode/genome/`) is the RAG index that powers `ashlr__grep`. Without
updates it drifts from the codebase as you edit files — causing grep to silently fall
back to ripgrep, which is slower and larger.

The auto-refresh pipeline (v1.23 Track HH) keeps the genome current without
requiring manual intervention.

---

## How the refresh cycle works

```
User edits file
      │
      ▼
PostToolUse hook: posttooluse-genome-refresh.ts
  ├─ Extract file path from Edit/Write/MultiEdit/NotebookEdit payload
  ├─ Append absolute path to ~/.ashlr/pending-genome-refresh.txt (deduped)
  └─ Exit 0 immediately (never blocks)

      │  (multiple edits accumulate, file is appended to)
      │
      ▼ (session ends)

SessionEnd hook: session-end-consolidate.ts
  ├─ 1. genome-auto-consolidate.ts  — merges proposals.jsonl
  ├─ 2. genome-cloud-push.ts        — pushes to team cloud (if configured)
  ├─ 3. genome-refresh-worker.ts    — incremental refresh ← NEW
  └─ 4. telemetry-flush.ts          — opt-in telemetry
```

### Debounce

The worker checks the mtime of `pending-genome-refresh.txt`. If it was written within
the last 2 seconds, processing is deferred (another edit may be in flight). This
prevents partial refreshes during rapid multi-file sessions. At session end the file is
always old enough to pass the debounce check.

### Incremental vs. full

**Incremental (default):** For each pending file, `_genome-live.refreshGenomeAfterEdit`
is called. It:
- Finds genome sections that reference the file (by filename or path)
- Verbatim sections: patches literal content in-place
- Summarized sections: invalidates (deletes) them so the propose queue regenerates

No LLM calls. Cost is proportional to the number of sections referencing the file.

**Full rebuild (`--full`):** Re-runs `genome-init.ts --force --minimal` for each
affected genome root. Rebuilds from scratch. No LLM summarization unless Ollama is
running. Use explicitly for schema upgrades or large structural refactors.

---

## Stale detection

When `ashlr__grep` finds a genome but gets zero matching sections, it:
1. Increments an in-session fallback counter
2. Emits a `genome_stale_detected` telemetry event (pattern + fallback count)
3. After **3 fallbacks in the same session**, surfaces a one-time nudge:

```
[ashlr] genome may be stale (3 grep queries fell through to ripgrep).
Run `bun run scripts/genome-refresh-worker.ts` to refresh, or
`bun run scripts/genome-refresh-worker.ts --full` for a complete rebuild.
```

This fires once per session so it doesn't spam repeated queries.

---

## File locations

| Path | Purpose |
|---|---|
| `~/.ashlr/pending-genome-refresh.txt` | Pending edit paths (one per line, deduped) |
| `hooks/posttooluse-genome-refresh.ts` | PostToolUse hook — records paths |
| `scripts/genome-refresh-worker.ts` | Worker — incremental refresh + `--full` mode |

---

## Manual refresh

```bash
# Incremental: refresh only files edited since last refresh
bun run scripts/genome-refresh-worker.ts

# Dry run: see what would be refreshed
bun run scripts/genome-refresh-worker.ts --dry-run

# Full rebuild (no LLM unless Ollama is running)
bun run scripts/genome-refresh-worker.ts --full

# Full rebuild, dry run
bun run scripts/genome-refresh-worker.ts --full --dry-run
```

---

## Kill switch

Set `ASHLR_GENOME_AUTO=0` to disable all genome automation (refresh, proposals,
consolidation). The pending file will still accumulate but nothing processes it.

---

## Gotchas

- **Pending file is cumulative.** If you kill Claude mid-session, the pending file
  persists across the next session start and is processed at the next session end.
- **Sections not referencing the file by name are not invalidated.** If your genome
  section uses a generic title (e.g. "Overview") with no mention of the filename in
  content/tags/summary, the refresh will miss it. Use descriptive section titles.
- **`--full` on large repos is slow.** It re-scans the entire project. Run it manually
  only when structural reorganization makes incremental refresh insufficient.
- **No LLM in the auto path.** The incremental worker never calls an LLM. The only
  LLM-touching path is `genome-init --summarize` (Ollama, opt-in), which is only
  reachable via `--full`.
