# Self-tuning compression

ashlr learns, per repo, when its compact output was not enough and adjusts how much detail it keeps.

## What counts as a miss

A miss is a compressed `ashlr__read` or `ashlr__grep` result for a target that is followed by a native `Read` or `Grep` of the same target within 3 tool calls (`MISS_WINDOW_TURNS`). Each compressed result counts at most one miss.

## How tuning works

Each ashlr tool and file extension pair has a detail level, default 0.

- Range: -2 to +2 (`MIN_DETAIL`, `MAX_DETAIL`).
- Nothing changes until a pair has 20 compressed results (`MIN_SAMPLES`).
- At most one step per 20 new results (`STEP`).
- A miss rate of 25% or more raises detail; 5% or less compresses harder; in between nothing moves.
- Each level multiplies the tool's byte budgets by 1.5 (`DETAIL_FACTOR`). Positive levels also raise the summarize threshold. Negative levels never lower it, so tuning never sends more output to an LLM summarizer.
- Level 0 gives exactly the same output as with tuning off.

The level applies to `ashlr__grep` (truncation budgets and summarize threshold) and `ashlr__read` (summarize threshold).

## On by default, and how to turn it off

Set `ASHLR_TUNING=off` to stop tracking and tuning; every level then reads as 0. `ASHLR_SESSION_LOG=0` also disables it. `/ashlr savings` shows which setting turned it off.

## What it stores

Local only, never uploaded. Counts only: no file paths, no file content.

- `~/.ashlr/miss-stats/<repo-hash>.json`: compressed and miss counts per tool and extension, plus per-week totals (compressed, misses, native re-read bytes).
- `~/.ashlr/tuning/<repo-hash>.json`: the level for each tool and extension.
- `~/.ashlr/repo-savings/<repo-hash>.json`: tokens saved in this repo per UTC week, recorded at the same point as the global savings stats (which are unchanged).
- `~/.ashlr/miss-pending/<session>.json`: recent compressed results as 8-character target hashes, pruned to the miss window.

`<repo-hash>` is a short hash of the working directory. Files are written owner-only (0600 in a 0700 directory).

Per-repo savings writes use a lock and atomic replacement so concurrent writers normally merge their increments and readers see complete JSON. Lock acquisition waits at most 250 ms and removes locks older than 5 seconds. On timeout or a lock access error, recording still attempts an atomic write; an increment can be lost under prolonged contention. Malformed lock paths cannot block tool calls indefinitely, and accounting errors never fail a tool call.

Caps: at most 64 extensions per tool (`MAX_EXT_KEYS`; the rest fold into `(other)`), the last 8 weeks (`MAX_WEEKS`, for both miss stats and repo savings), 256 pending entries per session (`MAX_PENDING`). Malformed or hand-edited files are ignored and defaults apply, so tuning state can never break a tool call.

## In /ashlr savings

The "self-tuning (this repo, UTC weeks)" section shows the last 4 ISO weeks (UTC, matching the daily savings keys) for the current repo only:

- saved tok: tokens saved by ashlr tools in this repo
- re-read (est.): native re-read bytes after misses divided by 4, an estimate in tokens
- net tok (est.): saved tok minus re-read (est.). Only the re-read cost is subtracted; other costs (for example the compact output itself, already netted into saved tok) are not. Shows n/a when the week has re-reads but zero recorded savings, since a negative net there would only reflect missing savings data.
- miss rate: misses divided by compressed results

The all-repo savings totals elsewhere in the report are not changed by this section.
