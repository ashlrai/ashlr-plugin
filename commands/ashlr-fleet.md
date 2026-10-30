---
name: ashlr-fleet
description: Explain the Phantom fleet pane, local peers, and governed Claude model routing.
---

Explain the native commands provided by the Phantom mod:

- `/top` opens a pane showing the local `phm top --json` snapshot. Fullscreen
  terminals dock it beside the transcript; other supported surfaces open it inline.
  It refreshes every three seconds while open. Closing it stops polling.
- `/peers` lists sessions in the local Locus peer registry.
- `/send PEER MESSAGE` sends only when the person enters the command themselves.
  Delivery requires a matching acknowledgment. An unconfirmed result must be
  checked before retrying, since retrying could duplicate a message.

Claude Code **2.1.309 or later** and a pinned Locus binding are required. The mod
asks the Phantom router for a model before every model request and subagent
spawn. Unavailable routing blocks the request. A fork whose router-selected model
differs from its inherited model is refused; use a non-fork subagent.

Force pushes and admin merge bypasses are denied. Publishing must use
`scripts/publish.sh` and still requires a person. All execution, writes,
configuration changes and unrecognized tools require the person decider.

If the mod reports unavailable, show the requirements and refer to
`mods/README.md` for the exact local command contracts. Do not claim that a
missing service means an empty fleet, or that a message was delivered.
Do not run a send, change bindings, install tools, or publish from this help command.

For a read-only local state snapshot, call `ashlr__fleet_state` with `{}`.
It reads only `~/.ashlr/fleet/targets.json` and `holds.json` (JSON objects or
arrays), plus `jobs.jsonl` and `leader-events.jsonl` (one JSON object per line).
Jobs are returned in append order, limited to the last 20; `leader_event` is
the last appended event. This file layout is the plugin's local reader contract;
no provider or fleet service is contacted. When every fleet file is absent, the
same shape is read from the router queue instead: `~/.ashlr-runs/queue/slots.json`
supplies lane targets, the `~/.ashlr-runs/HOLD` sentinel holds every lane (a JSON
object gives per-lane reasons verbatim, any other content is the shared reason),
`~/.ashlr-runs/metrics/jobs.jsonl` supplies the last 20 job records, and
`~/.ashlr-runs/queue/dispatch-events.log` (JSON records or timestamped dispatch
text) supplies `leader_event`. Error entries keep the canonical fleet file names
whichever layout served the read. Missing sources return `null` with
an entry in `errors`, while valid empty job logs return `[]`. Malformed,
unreadable, oversized (over 4 MiB), symlinked or hard-linked sources are
unavailable. The tool accepts no path or environment overrides and opens no
environment or secret files.

For typed local event NDJSON, run `bun scripts/fleet-watch.ts`. It reuses
`ashlr__fleet_events` to read complete lines from `~/.ashlr/dispatch-events.log`
and `~/.ashlr/metrics/jobs.jsonl`, draining all pages in source order.
Use `--since v1:DISPATCH:JOBS` with a cursor returned by `ashlr__fleet_events`
to resume after those physical line positions; this is a cursor, not a timestamp.
Add `--follow` to poll every second until SIGINT or SIGTERM. Diagnostics go to
stderr; stdout contains only typed events. Missing sources are retried in follow
mode; stale cursors and unsafe or unavailable sources exit nonzero without
rewinding. After log truncation, restart without `--since` to read from the start.

`ashlr__fleet_session({"job_id":"RQ-example"})` reads the latest matching
record from `~/.ashlr/fleet/jobs.jsonl` (by `id` or `job_id`) and the last
150 lines of `~/.ashlr/fleet/logs/RQ-example.log`. It returns job metadata,
metrics, `pr_url` (also accepting stored `prUrl`), worktree, logs and errors.
Missing logs return `null` with `errors.logs: "missing"`; empty logs return
`[]`. IDs allow only letters, digits, underscores and hyphens (128 characters
maximum). Paths from metadata are never opened. Reads reject links and files
over 4 MiB; token-like strings and credential fields are redacted throughout
the response. Keep credentials in Phantom Secrets rather than fleet logs.

`ashlr__fleet_intent` appends an audited pending request to
`~/.ashlr/fleet/intents.jsonl`; it does not execute fleet changes. Supply
`requested_by` and `reason` with every request. `pause`/`resume` require `lane`,
`kill` requires `job_id`, `reassign` requires both, and `set-slot` requires
`lane` and integer `slots` (0–1024). No caller-selected paths are accepted.

`ashlr__fleet_snapshot` returns the whole `~/.ashlr/fleet` view as one JSON
document: lanes (targets plus holds), every job upsert — not just the 20-row
tail `ashlr__fleet_state` shows — job-reported PR links, the latest leader
event and per-source errors. Pass the opaque `cursor` from a previous response
to receive only entries that changed since that read plus a `removed` list of
deleted ids. Cursors are scope-bound to the fleet root; malformed or foreign
cursors are rejected. Missing, unsafe or malformed sources come back as `null`
collections with entries in `errors`. Read-only; accepts no paths.

`ashlr__fleet_direction` reads the project direction with
`{"command":"read"}` (default `VISION.md`, or another top-level `*.md`
filename via `direction`) and records governed suggestions with
`{"command":"propose","author":"NAME","text":"MARKDOWN"}`. Proposals append a
dated, author-labelled blockquote to `DIRECTION-PROPOSED.md` in the project
root — they are suggestions, never adopted direction. `MASON-INBOX.md`,
`VISION.md` and every other file stay unwritable: the destination is fixed to
`DIRECTION-PROPOSED.md` and opened with nofollow and single-link checks.
Author names are single-line and at most 200 characters; proposal text is at
most 8192 characters. No caller-selected paths are accepted.

For lane steering proposals, run `bun scripts/fleet-steer.ts`. `lanes` reports
each lane's target, hold and deduplicated job count; `proposals` lists the
journal; `propose --action reassign --job-id JOB --lane LANE` proposes moving a
job and `propose --action set-slots --lane LANE --slots N` retargets lane
capacity (0–1024), each with `--author` and `--reason` required. Proposals
append audited JSON records to `~/.ashlr/fleet/steer-proposals.jsonl` only —
`slots.json` and every fleet state file stay unwritable, and a proposal
identical to one still pending is refused. Nothing proposed is applied.
