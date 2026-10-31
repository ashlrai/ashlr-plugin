# Fleet schema — the `~/.ashlr-runs` wire contract

`~/.ashlr-runs` is a drop zone: external producers (the Ashlr router,
dispatchd, lane monitors) write it and this plugin reads it with bounded,
link-free reads (`servers/_fleet-source.ts`). Producer and reader have already
diverged once — readers compensate with compat aliases like `job_id ?? id` and
`pool ?? lane` — so every record type below carries, or may carry, a
`schema_version` envelope. `FLEET_SCHEMA_VERSION` in
`servers/_fleet-source.ts` pins the version this reader understands
(currently **1**).

Reads are read-only and defensive: missing files report `missing`, malformed
JSON reports `invalid`, symlinked/hard-linked sources report `unsafe`, and
files over 4 MiB report `too_large`. Nothing here writes, executes or fetches.

## `schema_version` envelope

The reserved `schema_version` field carries an integer format version:

- **Absent** means the implicit v1 shape documented here — never warned.
- **Present and equal** to the reader pin is silently accepted.
- **Present and different** (newer, older, or non-integer) makes the reader
  emit **one stderr warning per file per process**
  (`[ashlr:fleet] <path>: schema_version …`) via `checkFleetSchema`, then
  continue the compat read instead of silently guessing.
- On **map-shaped** files (`slots.json`, `targets.json`, `holds.json`, `HOLD`
  JSON objects) it is a reserved top-level key — never a lane or hold entry —
  and readers strip it before enumerating lanes (`stripFleetEnvelope`).
- On **record-stream** files (`jobs.jsonl`, `dispatch-events.log`) it rides on
  each record independently.
- On **`ready.tsv`** it is a `# schema_version: <int>` comment directive.
- **New record types must carry it from day one**, together with a `type`
  discriminator (e.g. `queue.v1`), so a future reader bump is detectable
  instead of inferred.

## Files

### `queue/slots.json` — lane slot targets

Single JSON object mapping a lane (pool) name to its dispatch target:

```json
{ "dev": 2, "ops": { "target": 1, "held": true } }
```

| Field | Contract |
| --- | --- |
| `<lane>` | Lane (pool) name, `[A-Za-z0-9._@-]` — maps to an integer target **or** an object `{ "target": int, "held"?: bool }`. Integer targets are nonnegative safe integers. `held: true` marks the lane held. |
| `schema_version` | Reserved envelope key, not a lane. |

Feeds `targets` in `ashlr__fleet_state`; `queue/run/` supplies the live/ghost/held split against it.

### `metrics/jobs.jsonl` — job transition ledger

Append-only JSONL — one JSON object per line; the last record per job id wins
(upsert stream). Readers expose the trailing 20 records.

| Field | Contract |
| --- | --- |
| `job_id` | Job id, string. Aliases: `id`, `job` (`jobIdOf` order). |
| `pool` | Lane (pool) name. Alias: `lane`. |
| `state` | Current lifecycle state; canonical names per `docs/job-lifecycle.md` — `new`, `queued`, `dispatched`, `running`, `stalled`, `done`, `merged`, `failed`, `killed`, `deleted`. Aliases: `status`, `event`, `type` (event-name resolution order `type → event → state → status`); `outcome` rows carry the real transition in `state`. |
| `ts` / `timestamp` / `time` | Event time, ISO 8601 preferred. |
| `parent_job_id` | Id of the spawning job; alias `parent`. Drives `children` and kill cascades. |
| `pr_url` | Pull-request URL; alias `prUrl`. The router may instead write `pr` as `owner/repo#number`. |
| `worktree` | Absolute job worktree path, string. |
| `metrics` | Opaque metrics object, echoed verbatim. |
| `tokens`, `impact` | Nonnegative numbers; cumulative token spend / producer score. |
| `schema_version` | Per-record envelope. |

One malformed line invalidates the file for `fleet_state` (`invalid`); other
readers keep what parses.

### `queue/dispatch-events.log` — leader and dispatch events

Append-only mixed log. Each line is either:

- a JSON record `{ "type" | "event": <name>, "ts" | "timestamp": <ISO 8601>, "job_id"?: <id>, … }` — may carry `schema_version`; or
- router text `[<ISO 8601>] <type> <key>=<value>…`, e.g.
  `[2026-10-30T11:00:00Z] dispatched job=RQ-1`, where `job=`/`job_id=` carries the job id.

The last parseable line becomes `leader_event`; unparseable lines mark the
source `invalid` without hiding earlier events.

### `queue/ready.tsv` — queue projection

UTF-8 tab-separated queue export, one row per job. `#` lines are comments and
skipped. An optional header row names the columns; the canonical set is
`id status pool tier repo priority at`. Rows may instead be positional
(`status id pool tier repo title`, or `id pool tier repo title` when the
status column is absent) or `key=value` cells.

| Column | Contract |
| --- | --- |
| `id` | Job id (e.g. `RQ-…`); optional in raw rows. |
| `status` | Router status word — `READY`, `CLAIMED`, `LAND`, … READY rows give queue depth; in-flight statuses give live jobs. Defaults to `READY` when the file has no status column. |
| `pool` | Lane id; rows without a parseable pool are dropped, never guessed. |
| `tier`, `repo`, `priority`, `title` | Opaque labels; preserved, not mapped. |
| `at` | ISO 8601 row timestamp; required on `LAND` rows to count merges/hour. |

### `dispatchd/status.json` — dispatchd status document

Single JSON object, written atomically (temp file + rename) by dispatchd or
the drive bridge's `write-status` verb. Consumer contract:

| Field | Contract |
| --- | --- |
| `schema_version` / `schemaVersion` | Envelope; the metrics overlay pins `schemaVersion: 1`. |
| `jobsSha256` | Lowercase SHA-256 of the exact `jobs.jsonl` bytes the overlay binds to. |
| `jobs` | Per-job overlay entries `{ "id", "outcome", "tokens"?, "pr"?, "mergedAt"?, "reverted"?, "impact"? }`. `outcome` is `queued`, `running`, `merged`, `empty`, `failed` or `cancelled`; overlays replace supplied measurement fields, never add to prior totals. |
| `budgets` | Embedded pool-budget object — the same shape `phm budget show --json` prints (`fleet.budgets.v1`): `pools` keyed by lane with `weeklyPct`/`credits`/`acus`/`capacity` buckets carrying `remaining`, `resetAt`, `timestamp`, `source`, `state`, `burnPerHour`, `projectedExhaustion`. |

## Allied files the plugin also reads

| File | Contract |
| --- | --- |
| `HOLD` | Queue sentinel, not a record: presence means held. A JSON object is per-lane reasons verbatim; a JSON string list holds those lanes; any other content is the shared reason (first line, ≤500 chars). Absent = no hold. `schema_version` is stripped as above. |
| `ROUTER-QUEUE.md` | Markdown queue rows `- STATUS RQ-id (pool=lane, …)`; a `queue.v1` JSONL row counts its `status` field the same way. |
| `router-events.log` | JSONL router events; `AUTOAUTHOR` beats drive staleness checks. |
| `queue-author-codex.log` | Author journal; the last error/fatal/panic line is redacted and surfaced. |
| `queue/run/` | Per-job artifacts `<lane>/<job>.{base,log,log.gz,pid}` plus `<job>.phdrip` held markers — the live/ghost/held split. |
| `resources.json` | Fleet resource ledger regenerated by `ashlr resources --json` when stale (60 s TTL). |
| `supervisor/NEEDS-MASON.md`, `leader/MASON-INBOX.md` | Human-ask journals; rows carry ISO timestamps. |
