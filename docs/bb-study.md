# bb Study — get-bb/bb

> Internal study doc — 2026-10-30.
> Source: `github.com/get-bb/bb` @ `45ddc81` (MIT). Read: `docs/system-overview.md`, `packages/plugin-sdk`, `plugins/`, `.bb/`, contract packages.
> Rule: reimplement ideas, copy no code.

## The shape in one paragraph

bb splits into a **server** (SQLite + HTTP + WebSocket; stateless, DB is truth), a per-machine **host daemon** (workspaces, provider processes, local API), the **app**, and a **CLI** with parity to the app. A *thread* is the unit of work; an *environment* binds a workspace directory to a host. Almost every product behavior — worktrees, providers, workflows, connect — ships as a plugin against `@get-bb/plugin-sdk`, which is why bb can "build itself." Our fleet surface is the opposite shape: read-only JSONL inspectors plus one append-only intent journal, all pointed at `~/.ashlr/fleet/`.

## Findings

### 1. Threads — a transition table, not a pile of status strings

**bb**: `packages/domain/src/thread-lifecycle.ts` declares `THREAD_LIFECYCLE`: every status change is a named event with supersession predicates (`notArchived`, `notDeleted`) checked inside the writer's transaction. `packages/db/src/data/threads.ts` (`applyThreadLifecycleEvent`) is the only mutator; illegal transitions are logged no-ops, never crashes. `docs/lifecycle-diagrams.md` is *generated* from the table by a vitest, so the doc cannot drift. `ARCHIVE_UNDO_GRACE_MS` (`apps/server/src/services/threads/archive-undo-grace.ts`) keeps an archived thread restorable for 30s.

**Gap**: `jobs.jsonl` is an untyped append log. `servers/fleet-state-server-handlers.ts`, `servers/fleet-session-server-handlers.ts`, and `scripts/fleet-ui-server.ts` each re-derive "current status" by taking the last matching line; there is no legality (a `succeeded` followed by `running` silently wins), no supersession, and one malformed line invalidates the whole file. Kill is an intent row, not a state.

**Ship it**: port the pattern, not the code — `servers/_job-lifecycle.ts` exporting `JOB_LIFECYCLE` + `applyJobEvent(job, event)` with `notKilled`/`notDeleted` predicates; fold `jobs.jsonl` through it in `servers/fleet-state-server-handlers.ts`; generate a mermaid diagram in `__tests__/fleet-lifecycle.test.ts` so table and doc stay in lockstep.

### 2. Plugins — an SDK facade over a runtime the host installs

**bb**: `packages/plugin-sdk/src/app.ts` exports forwarders that resolve `globalThis.__bbPluginRuntime` at call time, so plugin bundles carry no host code and load order is irrelevant. The surface is enumerated in `plugins/plugin-api-docs/src/surfaces.ts`; new API needs an `experimental_` prefix plus an audit entry in `docs/api_to_audit.md`. `scripts/forkable-plugins.json` + the `check:plugin-forks` CI prove a built-in plugin copied out of the repo still builds against the *published* SDK — the extension seam is continuously tested, not asserted.

**Gap**: `scripts/fleet-ui/` is a compiled monolith — adding a panel means editing `fleet-ui-server.ts`, new JS, new tests, all in core. There is no surface manifest, no isolation boundary, and no way for a second contributor to extend the UI without owning the server file.

**Ship it**: a surfaces manifest at fleet scale — `scripts/fleet-ui/panels.json` (new) declaring `{id, script, title, lanes}` per panel; `scripts/fleet-ui-server.ts` mounts panels from the manifest instead of hardcoding them; `__tests__/fleet-ui-panels.test.ts` (new) asserts every manifest entry resolves to a shipped file with a valid CSP-safe script tag.

### 3. Spawn — one verb on every surface, with an explicit owner

**bb**: `apps/cli/src/commands/thread/spawn.ts` — `bb thread spawn --project … --new-environment worktree --machine … --lifecycle-owner-thread … --parent-self` (the last reads `BB_THREAD_ID`, so an agent inside a thread can parent its own children). The same spawn exists in the SDK (`threads.spawn`) and inside plugins via `bb.sdk.threads.spawn` (`packages/plugin-sdk/src/backend-contract.ts`) with `origin: "plugin"` stamped automatically. Spawn accepts a live owner across projects, hosts, and environments.

**Gap**: the fleet has no spawn verb at all. Jobs exist only because an external router happened to write `jobs.jsonl`; `servers/fleet-actions-server-handlers.ts` can `pause`/`resume`/`kill`/`reassign`/`slots`/`steer` but cannot create work. A lane at zero utilization just idles until the router notices.

**Ship it**: add `spawn` to the `fields` map in `servers/fleet-actions-server-handlers.ts` (`["lane", "message"]` — message is the prompt), letting agents file an audited spawn intent in `actions.jsonl` for the controller; expose it in `scripts/fleet-steer.ts propose --action spawn`; extend `__tests__/fleet-actions-mcp.test.ts`.

### 4. Agent handoff — owned workers that report back

**bb**: delegation is three coordinated mechanisms. `lifecycleOwnerThreadId` (`docs/system-overview.md`) makes archive/delete of an owner cascade to dependents. `plugins/workflows` runs a sandboxed script whose `agent(...)` calls spawn ordinary worker threads; `bb_workflow_run` / `bb_workflow_result` give structured in/out, and successful calls are cached so a restarted run replays to the first uncached step — handoff survives restarts. `plugins/tasks` delegates via presets that attach a report-back contract to the worker; `plugins/side-chat` forks a thread and its "send to main" queues while the parent is busy.

**Gap**: jobs have no `owner`/`parent` field anywhere — the only sibling logic in the tree (`scripts/fleet-recut-siblings.ts`) reasons about GitHub PRs, not job lineage. `steer` messages are fire-and-forget appends with no delivery receipt and no queueing semantics, and `kill` does not cascade. A "manager" job that dies leaves children running with no record of the relationship.

**Ship it**: `owner_job_id` on job records, honored everywhere: `servers/fleet-session-server-handlers.ts` returns `children: [job_id]`; `kill` in `servers/fleet-actions-server-handlers.ts` records `cascade: true` so the controller knows intent; `scripts/fleet-ui/session-panel.js` renders the child list. Tests: `__tests__/fleet-owner.test.ts` (new).

### 5. Per-worktree isolation — owned paths with a hook contract

**bb**: `plugins/environment-git-worktree` (`server.ts`, `host/worktree-include.ts`) creates a managed `git worktree` per thread under the plugin's host-data dir. `.worktreeinclude` (gitignore syntax) copies untracked locals like `.env` in before setup; `.bb-env-setup.sh` / `.bb-env-teardown.sh` run only when the provider reports `ownsPath: true`, with closed stdin, a 15-minute timeout, and a streamed provisioning transcript (`docs/worktrees.md`). Removal kills every process whose cwd is inside (SIGTERM → SIGKILL via `packages/plugin-sdk/src/kill-processes.ts`), then `git worktree remove --force`; the branch survives. Environment state is its own machine: `packages/domain/src/environment-lifecycle.ts`.

**Gap**: `job.worktree` is an opaque string. Nothing records whether the fleet owns the path, so cleanup policy is guesswork; there is no include-manifest, no setup/teardown hook contract, and `scripts/fleet-dirty-triage.ts` can only report dirtiness after the fact. Stray processes in an abandoned worktree are never reaped.

**Ship it**: the ownership bit plus the manifest — add `owned` and `setup_status` fields surfaced by `servers/fleet-session-server-handlers.ts`; `servers/_worktree-include.ts` (new) parses `.worktreeinclude`-syntax manifests; `scripts/fleet-dirty-triage.ts` flags owned worktrees missing required local files *before* the job runs. Tests: `__tests__/worktree-include.test.ts` (new).

### 6. Remote access — a gate that asserts identity; loopback keeps local trust

**bb**: `apps/connect/src/worker.ts` (Cloudflare Worker + D1 + Durable Objects) terminates public TLS and signs an Ed25519 `x-bb-gate-assertion` per request, bound to method+path and a 60s expiry. The server verifies it on a *separate* loopback ingress (`apps/server/src/services/connect-next/tunnel-ingress.ts`, `gate-keys.ts` fetches public keys from a well-known URL) — the main loopback port never sees internet traffic. Pairing codes are 10-minute single-use; each device holds its own credential; revocation propagates in ~20s (`docs/multiple-devices.md`). Share ports get `Origin` rewrites so dev-server HMR survives the tunnel.

**Gap**: `scripts/fleet-ui-server.ts` binds `127.0.0.1` with a strict CSP — correct, but it means the mobile PWA (`scripts/fleet-ui/mobile.html`) cannot leave the laptop, and the only remote access story is "SSH in and read `~/.ashlr`." There is no device concept, no credential, no read-only share.

**Ship it**: assertion-style sharing without a tunnel — `bun scripts/fleet-ui-server.ts --share` mints a time-boxed token into `~/.ashlr/fleet/share-token.json` (mode 0600); a new `/share/*` route scope in `servers/fleet-share-server-handlers.ts` (new) accepts only `GET` fleet-state/session/events endpoints behind a constant-time bearer check. Loopback stays unauthenticated; remote stays read-only. Tests: `__tests__/fleet-share.test.ts` (new).

### 7. Cross-cutting — versioned wire contracts and one durable store

**bb**: `packages/server-contract` and `packages/host-daemon-contract` own every wire schema; `HOST_DAEMON_PROTOCOL_VERSION` (`packages/host-daemon-contract/src/protocol.ts`) must increment on any field change, which is what lets enrolled machines self-update without version skew. All product state lives in one SQLite DB (`~/.bb/bb.db`); the server is disposable. Per-server daemon state is isolated under `~/.bb-machines/<server>`.

**Gap**: fleet files are unversioned JSONL. Readers already compensate for drift — `job.job_id ?? job.id`, `job.pool ?? job.lane` — which means the producer and this plugin have *already* diverged once. There is no `schema_version`, no migration path, and corruption handling is per-file "invalid" with no granularity.

**Ship it**: declare the schema — `docs/fleet-schema.md` pinning each file's fields and a `schema_version` envelope for new record types; `servers/fleet-state-server-handlers.ts` warns once per file on version mismatch instead of silently guessing. Tests: `__tests__/fleet-schema.test.ts`.

## What not to copy

- bb's plugin runtime is the product; ours is a monitoring surface. Take the *manifest* (finding 2), not a module loader.
- bb's tunnel needs an account backend. Take the *assertion boundary* (finding 6): unauthenticated loopback, signed everything else.
- bb's SQLite-everything is right for a server owning threads; `~/.ashlr/fleet/` is a drop zone other tools write. Keep files, add *schemas and transition tables* (findings 1, 7) instead of a database.
