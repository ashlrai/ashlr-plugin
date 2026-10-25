# Phantom agent preflight in `ashlr doctor`

`ashlr doctor` can run Phantom's value-free agent preflight,
`phantom agent doctor --json --strict`, and show its verdict as a
`phantom preflight` line in the install section. It is off by default.

| `ASHLR_PHANTOM_PREFLIGHT` | Line status |
|---|---|
| unset, `0` | No line; phantom is not run. |
| `1`, `true`, `on` | `ready` ok, `degraded` or `unknown` warn, `blocked` fail. |
| `strict` | `ready` ok, anything else fail. |

The preflight follows phantom-secrets
[docs/agent-preflight-contract.md](https://github.com/ashlrai/phantom-secrets/blob/main/docs/agent-preflight-contract.md)
(schema version 1; `--strict` exits 0 ready, 2 degraded, 1 blocked, 3 could
not evaluate). It reads only project files and environment variables: no vault
open, no keychain access.

The line shows the verdict and, when blocked, the critical check ids. It never
shows secret names, values or phantom's own messages. A missing `phantom`, or a
version without `agent doctor --json`, gives a warning line and nothing else.
Run `phantom agent doctor` for the full report and fix commands, and run tools
with `phantom exec -- <cmd>` so they get `phm_` placeholders instead of keys.
