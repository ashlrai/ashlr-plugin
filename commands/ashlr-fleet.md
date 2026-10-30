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
no provider or fleet service is contacted. Missing sources return `null` with
an entry in `errors`, while valid empty job logs return `[]`. Malformed,
unreadable, oversized (over 4 MiB), symlinked or hard-linked sources are
unavailable. The tool accepts no path or environment overrides and opens no
environment or secret files.

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
