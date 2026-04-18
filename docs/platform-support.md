# Platform Support

ashlr-plugin is tested on Linux, macOS, and Windows in CI on every push via a matrix strategy.

---

## CI Matrix

| Job | Ubuntu 22.04 | macOS 14 | Windows Server 2022 |
|---|---|---|---|
| `typecheck` | yes | yes | yes |
| `test` | yes | yes | yes |
| `smoke` (realtime) | yes | yes | yes |
| `smoke` (cross-platform) | yes | yes | yes |
| `benchmark-check` | yes | — | — |
| `integration` | yes | — | — |

`benchmark-check` and `integration` run Linux-only. Benchmarks are not OS-sensitive; integration tests spawn the backend server which is deployed on Linux.

---

## ripgrep Installation

ripgrep must be on `PATH`. Install guidance per platform:

| Platform | Recommended command |
|---|---|
| Linux (Debian/Ubuntu) | `sudo apt-get install -y ripgrep` |
| macOS | `brew install ripgrep` |
| Windows | `winget install BurntSushi.ripgrep.MSVC` or `choco install ripgrep` |

The CI workflow installs ripgrep automatically in each matrix leg.

---

## Known Limitations by Platform

### Windows

| Feature | Status | Notes |
|---|---|---|
| `ashlr__read` | Full | Path separator handled via `path.join`; URL pathname stripping for `file://` on Windows |
| `ashlr__grep` | Full | ripgrep binary must be installed separately (see above) |
| `ashlr__edit` | Full | No known issues |
| `ashlr__savings` | Full | No known issues |
| `ashlr-bash` server | Partial | Spawns `sh -c`; requires Git for Windows or WSL in `PATH`. Tests that call `sh` directly are skipped on Windows in CI. |
| File permissions (chmod) | N/A | Windows does not honour POSIX mode bits. Three tests are explicitly skipped — see below. |
| Genome init | Full | No known issues |
| VS Code extension | Full | `.vsix` packaged and attached to release |

#### Tests skipped on Windows

These tests are marked `test.skipIf(process.platform === "win32")` with an explanatory comment:

| File | Test name | Reason |
|---|---|---|
| `__tests__/genome-crypto.test.ts` | `key file is written with mode 0600` | `stat.mode & 0o077` is meaningless on Windows — the OS does not set POSIX permission bits |
| `__tests__/genome-init.test.ts` | `handles unreadable dir (graceful fallback to empty graph)` | `chmodSync(dir, 0o000)` does not make the directory unreadable on Windows; the test would give a false pass |
| `__tests__/doctor.test.ts` | `non-executable hooks produce warnings with chmod fix` | Windows has no execute bit concept; `chmod 0o644` is a no-op and the `chmod +x` fix suggestion is irrelevant |

These skips are explicit — the test runner reports them as `skipped`, not silently passing.

### macOS

| Feature | Status | Notes |
|---|---|---|
| All tools | Full | No known issues |
| File permissions | Full | POSIX mode bits work as expected |
| `ashlr-bash` server | Full | `sh` and `bash` available by default |
| Genome | Full | No known issues |

### Linux

| Feature | Status | Notes |
|---|---|---|
| All tools | Full | Reference platform |
| Integration tests | Full | Only platform where `integration` job runs |
| File permissions | Full | POSIX mode bits work as expected |

---

## Line Endings

The CI checkout step sets `core.autocrlf false` on all matrix legs:

```yaml
- name: Disable CRLF auto-conversion (Windows)
  if: runner.os == 'Windows'
  shell: bash
  run: git config --global core.autocrlf false
```

This prevents git from silently converting LF to CRLF on Windows, which would break hash-based cache keys and text-comparison assertions in tests.

Source files in this repository use LF line endings exclusively (enforced by `.gitattributes` if present).

---

## Cache Keys

Node module caches are keyed by `runner.os` to prevent cross-platform cache poisoning:

```yaml
key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
```

Without the `runner.os` prefix, a Linux-built `node_modules` cache could be restored on Windows, causing native module mismatches.

---

## Expected CI Wall Times

Approximate worst-case times per OS based on job structure:

| OS | `typecheck` | `test` | `smoke` | Total |
|---|---|---|---|---|
| Ubuntu | ~1 min | ~3 min | ~1 min | ~5 min |
| macOS | ~2 min | ~4 min | ~2 min | ~8 min |
| Windows | ~3 min | ~6 min | ~3 min | ~12 min |

Windows is slowest due to ripgrep install via winget/choco and generally slower I/O on GitHub-hosted runners. All jobs target under 15 minutes.
