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
