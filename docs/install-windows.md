# Installing ashlr-plugin on Windows

ashlr-plugin runs on Windows via [Bun for Windows](https://bun.sh/docs/installation#windows).
All hooks are TypeScript files invoked with `bun run` — no bash or POSIX shell required.

## Prerequisites

1. **Bun for Windows** (1.x or later)

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

   Verify:

   ```powershell
   bun --version
   ```

2. **Claude Code** — install the standard way from [claude.ai/claude-code](https://claude.ai/claude-code).
   Claude Code on Windows is supported via the official installer.

3. **Git for Windows** — required for any git-related tools (`ashlr__diff`, commit attribution).
   Download from [git-scm.com](https://git-scm.com/download/win).

4. **ripgrep** (optional, improves `ashlr__grep` performance)

   ```powershell
   winget install BurntSushi.ripgrep.MSVC
   ```

## Install

```powershell
# Clone the plugin
git clone https://github.com/ashlrai/ashlr-plugin "$env:USERPROFILE\.claude\plugins\ashlr-plugin"

# Install dependencies
cd "$env:USERPROFILE\.claude\plugins\ashlr-plugin"
bun install
```

Then follow the [standard setup instructions](../README.md) to register the plugin with Claude Code.

Alternatively, use the PowerShell install script:

```powershell
irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
```

## Shell behavior

On Windows, `ashlr__bash` uses **PowerShell** (`pwsh` if available, otherwise `powershell`)
instead of `/bin/sh`. This means:

- Commands like `ls`, `cat`, `rm` use their PowerShell aliases, not POSIX tools.
- If you need POSIX shell behavior, install [Git for Windows](https://git-scm.com) and
  set `SHELL=C:\Program Files\Git\bin\bash.exe` in your environment.
- `ASHLR_SHELL` is not currently supported — use the `SHELL` env var.

## Key file permissions (genome encryption)

On POSIX systems, `~/.ashlr/team-keys/*.key` files are protected with `chmod 0600`.
On Windows, NTFS does not support POSIX ACLs. ashlr-plugin logs a one-time warning
and continues — the file is written but not restricted at the OS level.

Recommended mitigations (choose one):

- **BitLocker**: Encrypt the entire volume containing your user profile. This protects
  all files in `%USERPROFILE%` including `~/.ashlr/team-keys/`.
- **Windows EFS**: Right-click `%USERPROFILE%\.ashlr\team-keys\` in Explorer,
  Properties > Advanced > Encrypt contents. EFS ties decryption to your Windows
  login credentials.
- **Dedicated protected directory**: Move key storage to a BitLocker-protected
  secondary drive or VeraCrypt container.

ashlr-plugin does not throw when chmod has no effect on Windows — it logs the
warning to stderr and writes the key file successfully.

## Verifying the install

```powershell
bun run test
bun run typecheck
```

All tests should pass. The cross-platform tests in `__tests__/cross-platform.test.ts`
include Windows-gated assertions that are verified in CI.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `bun: command not found` | Re-run the Bun installer and open a new terminal |
| `git: command not found` | Install Git for Windows and ensure it's on PATH |
| `rg: command not found` | Install via `winget install BurntSushi.ripgrep.MSVC` or skip (ashlr__grep falls back gracefully) |
| Hook errors mentioning `bash` | Ensure hooks.json points at `.ts` files (not `.sh`). Run `bun run scripts/doctor.ts` |
| Key file warning on every session | Expected on Windows — see "Key file permissions" above |

## WSL (optional)

If you prefer a full Linux environment, you can install ashlr-plugin inside
[WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) using the standard
[install.sh](./install.sh) script. The bash hooks are not required — the TypeScript
hooks work in WSL too.
