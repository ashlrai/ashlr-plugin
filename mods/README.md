# Phantom Claude Code mod

Load this repository as a Claude plugin. `hooks/hooks.json` names `register.ts`
as its one function-hooks module. Requires **Claude Code 2.1.309+**, with function
hooks enabled on that host, compatible local Phantom/Locus CLIs, and an existing
pinned Locus binding. No installation, credential resolution, provider pinning,
daemon startup, publishing, or messaging occurs automatically.

The minimum version is checked once per activation using bounded
`claude --version`; PATH must resolve the same build as the running host.
There is no host-stamped version getter in the locally available SDK.
Unparseable versions, prereleases, missing executables, and
older hosts fail closed for model requests, spawns, and tool checks. The extra
`tool.check` result field `decider: "person"` requires 2.1.309; older hosts must
not be used to qualify that field. Exceptions and hook-budget failures have
explicit deny/stop catch handlers. The mod never returns a tool allow verdict.
Native read tools continue through Claude's existing policy; every other tool
requires a person. This is a human review boundary, not a complete shell parser:
recognizable forbidden commands are denied, and opaque code still needs review.

`/top` opens a docked fleet pane on a fullscreen surface, inline otherwise.
Fullscreen PromptHint rendering also requests it once automatically; narrow or
unsupported surfaces may refuse placement. No focus is stolen. Polling is every
three seconds, bounded to one in-flight sample, with a two-second child deadline.
Closing the pane or ending the session cancels polling; late placement/snapshot
results cannot restart it or overwrite a newly opened pane. Failures replace the
snapshot with unavailable rather than continuing to display stale healthy data.

`/peers` reports local advisory peer metadata. `/send PEER MESSAGE` accepts a
single registered session label and up to 8192 message characters. Quote labels
containing spaces, for example `/send "Review Agent" hello`. Labels are opaque
UTF-8 strings up to 128 bytes; controls and invisible formatting are refused. The body is
stdin JSON, never shell text or a command-line flag. Only a person-origin composer
command sends. A matching explicit acknowledgment is required; no automatic
retry follows a timeout or malformed receipt. Discovery is not authorization.

## Integration contracts and qualification

All commands use the host's argv-based `$.process.run` with a two-second timeout.
Phantom commands run via `locus exec --no-resolve -- phm ...`, retaining Locus's
existing binding gates without resolving secrets. Locus peer clients must use
only `127.0.0.1`, with redirects and proxy discovery disabled. The mod does not
use HTTP, sockets, environment reads, or Node APIs, and accepts no remote URL.
It relies on the CLI contracts for their transport confinement; Locus is an
identity boundary, not a network sandbox. Tests stub every child command and
perform no network operations.

| Operation | Exact argv after the executable | Input | Required output |
| --- | --- | --- | --- |
| Host version (`claude`) | `--version` | none | stable semantic version, optionally followed by `(Claude Code)` |
| Fleet (`locus`) | `exec --no-resolve -- phm top --json` | none | JSON object, at most 64 KiB |
| Route (`locus`) | `exec --no-resolve -- phm router select --json` | stdin JSON: `event`, current `model`, and step identity/counts or `subagentType`/`fork` | JSON object containing a nonempty `model` identifier |
| Discover (`locus`) | `peers list --json` | none | `{ "peers": [{ "session_id", "engine_id", "task" }] }` |
| Send (`locus`) | `peers send --json` | stdin JSON: `{ "to": "session-label", "message": "body" }` | `{ "delivered": true, "to": "session-label" }` |

The selected model is used directly; fork spawns with conflicting routes fail
because Claude forks inherit their parent's model. Routing failures stream a
visible unavailable message without dispatching an ungoverned model request.
Route input excludes transcripts, task prompts, working directories, credentials,
and environment values. Child failures never echo stdout/stderr diagnostics.
Display labels strip terminal controls and bidi formatting. Responses are bounded;
malformed output, missing fields, duplicate peers, and ambiguous send receipts fail.

**Upstream gaps found on this workstation:** installed Claude is 2.1.280, installed
Phantom has no `top` or router selection contract, and installed Locus has no
`peers` command. The in-progress Locus registry implements `peers list --json`
but has no message transport. Router selection and peer-send rows above are
explicit integration contracts proposed by this adapter, not verified upstream
APIs. Until those CLIs implement them and a 2.1.309+ host is available, runtime
acceptance is blocked. Stub results do not establish live interoperability.

The repository's npm `files` allowlist omits `mods/`. This change is loadable
from a Git checkout; npm distribution needs a separately authorized packaging
change. `package.json`, lockfiles, publish scripts and server code are untouched.

## Local verification

```sh
HOME=$(mktemp -d) CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .claude-plugin/plugin.json
HOME=$(mktemp -d) bun run typecheck
HOME=$(mktemp -d) bun run mdx-lint
HOME=$(mktemp -d) bun test hooks/phantom-policy.test.ts mods/bridge.test.ts mods/register.test.ts
HOME=$(mktemp -d) bun run mods/engine-contract.ts
HOME=$(mktemp -d) bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target esnext --module esnext --moduleResolution bundler --allowImportingTsExtensions --types bun mods/*.ts
```

The explicit mods check matters: root TypeScript and root test discovery do not
include `mods/`. Publication remains a separate owner-controlled step through
the repository's existing `scripts/publish.sh`; it must not be run during this job.
