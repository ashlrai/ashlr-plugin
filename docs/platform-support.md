# Platform Support

ashlr-plugin is tested on Linux, macOS, and Windows in `.github/workflows/ci.yml`. Pull requests and merge-queue entries run only the fast gate (version sync, plus install, typecheck and a site release-facts check for code changes) and the secret-shape scan. The full cross-platform suite runs on the daily schedule and on manual dispatch.

---

## CI Matrix

The full run uses GitHub-hosted runners by label. GitHub moves each `-latest` label to newer OS images over time; [actions/runner-images](https://github.com/actions/runner-images) lists the image each label points to today.

| Check | `ubuntu-latest` | `macos-latest` | `windows-latest` |
|---|---|---|---|
| Registered MCP tool count (`bun run smoke:tools`) | yes | yes | yes |
| `bun run typecheck` | yes | yes | yes |
| Unit tests (`bun run test`) | yes | yes | yes |
| Real-time counters smoke (`scripts/smoke-realtime.ts`) | yes | yes | yes |
| Cross-platform smoke (`scripts/smoke-cross-platform.ts`) | yes | yes | yes |
| `server/`, `site/` and `vscode/` checks | yes | — | — |
| Benchmark dry run | yes | — | — |
| `integration/` suite | yes | — | — |
| MCP server smoke (`integration-windows`) | — | — | yes |

The Linux checks run in one `linux checks` job. The macOS and Windows jobs, and the Windows MCP server smoke, start only after that job passes. The smoke spawns the MCP entrypoint and checks that `ashlr__read`, `ashlr__grep` and `ashlr__savings` answer. The `integration/` suite runs on Linux only because it spawns the backend server, which is deployed on Linux. The benchmark refresh job runs on the daily schedule only.

---

## ripgrep Installation

ripgrep must be on `PATH`. Install guidance per platform:

| Platform | Recommended command |
|---|---|
| Linux (Debian/Ubuntu) | `sudo apt-get install -y ripgrep` |
| macOS | `brew install ripgrep` |
| Windows | `winget install BurntSushi.ripgrep.MSVC` or `choco install ripgrep` |

CI installs ripgrep in each job that needs it: `apt-get` on Linux, `brew` on macOS and `choco` on Windows. CI does not use `winget`, because it needs a store source agreement that breaks in CI.

---

## Known Limitations by Platform

### Windows

| Feature | Status | Notes |
|---|---|---|
| `ashlr__read` | Full | Path separator handled via `path.join`; URL pathname stripping for `file://` on Windows |
| `ashlr__grep` | Full | ripgrep binary must be installed separately (see above) |
| `ashlr__edit` | Full | No known issues |
| `ashlr__savings` | Full | No known issues |
| `ashlr__bash` | Full | Runs commands with PowerShell (`pwsh`, falling back to `powershell`) and `-NoProfile -NonInteractive -Command`, so commands must be PowerShell syntax. Process-group cleanup tests are POSIX-only and skipped on Windows. |
| File permissions (chmod) | N/A | Windows does not honour POSIX mode bits. The tests that check them are skipped; see below. |
| Genome init | Full | No known issues |
| VS Code extension | Full | `.vsix` packaged and attached to release |

#### Tests skipped on Windows

These permission tests are marked `test.skipIf(process.platform === "win32")` with an explanatory comment:

| File | Test name | Reason |
|---|---|---|
| `__tests__/genome-crypto.test.ts` | `key file is written with mode 0600` | `stat.mode & 0o077` is meaningless on Windows — the OS does not set POSIX permission bits |
| `__tests__/genome-init.test.ts` | `handles unreadable dir (graceful fallback to empty graph)` | `chmodSync(dir, 0o000)` does not make the directory unreadable on Windows; the test would give a false pass |
| `__tests__/doctor.test.ts` | `non-executable hooks produce warnings with chmod fix` | Windows has no execute bit concept; `chmod 0o644` is a no-op and the `chmod +x` fix suggestion is irrelevant |

A few other cases are skipped on Windows, each with its reason in the test file: process-group cleanup in `__tests__/bash-server.test.ts`, the read-only-directory atomicity case in `__tests__/multi-edit-server.test.ts`, the broken-ripgrep case in `__tests__/first-run-tools-list.test.ts`, and the slow subprocess cases in `__tests__/sql-server.test.ts`.

These skips are explicit — the test runner reports them as `skipped`, not silently passing.

#### Protecting `~/.ashlr/team-keys/` on Windows

`saveKey` in `servers/_genome-crypto.ts` calls `writeFile(..., { mode: 0o600 })` and `chmod(p, 0o600)`. Both are silent no-ops on NTFS — the file inherits whatever ACLs the parent directory had. Under the user profile (`%USERPROFILE%\.ashlr\team-keys\`) the default ACLs typically resolve to user + Administrators + SYSTEM, but that is not guaranteed on roaming profiles, domain-joined machines, or directories the user created manually. ashlr prints a per-file warning every time a team key is written so you can't miss it.

Recommended mitigations (in order of strength):

- **BitLocker** — encrypts the whole drive, including `~/.ashlr/`. Enable via Settings → Privacy & security → Device encryption, or `manage-bde -on C:` from an elevated prompt.
- **Windows EFS** — per-file encryption bound to the user account: `cipher /e /s:%USERPROFILE%\.ashlr\team-keys`. Survives disk-level theft; does not protect against an attacker who gains the user's login credentials.
- **Tight ACLs** — explicitly restrict to the current user: `icacls "%USERPROFILE%\.ashlr\team-keys" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`. Verify with `icacls "%USERPROFILE%\.ashlr\team-keys"`.

POSIX systems (Linux, macOS) honour the `chmod 0600` directly and don't need any of the above.

### macOS

| Feature | Status | Notes |
|---|---|---|
| All tools | Full | No known issues |
| File permissions | Full | POSIX mode bits work as expected |
| `ashlr__bash` | Full | Runs commands with `$SHELL -c`, falling back to `/bin/sh` |
| Genome | Full | No known issues |

### Linux

| Feature | Status | Notes |
|---|---|---|
| All tools | Full | Reference platform |
| `ashlr__bash` | Full | Runs commands with `$SHELL -c`, falling back to `/bin/sh` |
| Integration tests | Full | Only platform where the `integration/` suite runs |
| File permissions | Full | POSIX mode bits work as expected |

---

## Line Endings

Every Windows CI job turns off CRLF conversion before it checks out the repository:

```yaml
- name: Disable CRLF auto-conversion (Windows)
  if: runner.os == 'Windows'
  shell: bash
  run: git config --global core.autocrlf false
```

This prevents git from silently converting LF to CRLF on Windows, which would break hash-based cache keys and text-comparison assertions in tests.

Files in the repository are committed with LF line endings. `.gitattributes` does not enforce this; it only sets `merge=union` for `CHANGELOG.md`.

---

## Cache Keys

Node module caches are keyed by `runner.os` to prevent cross-platform cache poisoning:

```yaml
key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
```

Without the `runner.os` prefix, a Linux-built `node_modules` cache could be restored on Windows, causing native module mismatches. The `linux checks` job uses its own `bun-linux-all-…` key, because it also caches the `server/`, `site/`, `vscode/` and `integration/` dependencies.

---

## CI Time Limits

Each job has a `timeout-minutes` limit in `ci.yml`:

| Job | Runner | Limit |
|---|---|---|
| `fast checks` | `ubuntu-latest` | 10 min |
| `Secret-shape scan` | `ubuntu-latest` | 5 min |
| `linux checks` | `ubuntu-latest` | 15 min |
| `checks (macos-latest)`, `checks (windows-latest)` | `macos-latest`, `windows-latest` | 20 min |
| `integration-windows` | `windows-latest` | 10 min |
| `benchmark` | `ubuntu-latest` | 30 min |

The smoke-test steps have their own 2-minute limits, and the Windows MCP server smoke step has 3 minutes.
