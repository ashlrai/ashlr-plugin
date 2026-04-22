# Installing ashlr-plugin on Windows

ashlr-plugin runs on Windows via [Bun for Windows](https://bun.sh/docs/installation#windows).
All hooks are TypeScript files invoked with `bun run` — no bash or POSIX shell required.

## Prerequisites

1. **Bun for Windows** (1.x or later) — the installer will offer to install this automatically if missing.

   Manual install:

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **Claude Code** — install the standard way from [claude.ai/claude-code](https://claude.ai/claude-code).

3. **Git for Windows** — required for clone and git-related tools (`ashlr__diff`, commit attribution).
   Download from [git-scm.com](https://git-scm.com/download/win).

4. **ripgrep** (optional, improves `ashlr__grep` performance)

   ```powershell
   winget install BurntSushi.ripgrep.MSVC
   ```

## Install

Run the installer — it handles cloning, dependency install, and stale-cache cleanup:

```powershell
irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
```

If Bun is not installed, the script will ask:

```
[ashlr] Bun is required but not found.
[ashlr] Install Bun now? (Y/n)
```

Press Enter (or Y) to let the installer fetch and configure Bun automatically. If you
decline, install Bun manually first and re-run.

The installer clones to:

```
%USERPROFILE%\.claude\plugins\cache\ashlr-marketplace\ashlr\<version>\
```

This matches the path Claude Code's marketplace flow expects, so `/plugin install` is
instant and re-runs update the active copy rather than creating orphan directories.

After the script completes, run these two commands inside Claude Code:

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

Then restart Claude Code.

## Migration note

If you previously installed with an older version of this script, you may have an orphan
copy at `%USERPROFILE%\.claude\plugins\ashlr-plugin\`. It is safe to delete that directory
manually — it is not referenced by Claude Code's marketplace flow.

## Bun auto-install

Both `install.ps1` (Windows) and `install.sh` (macOS/Linux) offer an interactive Bun
install prompt when Bun is missing. On Windows:

- The script runs `irm bun.sh/install.ps1 | iex` via an inner `powershell` call.
- After install it refreshes `PATH` in the current session and re-checks.
- If Bun still isn't on PATH (rare, requires a new shell), exit 1 with instructions.

On macOS/Linux, `install.sh` only offers the prompt when stdin is a terminal (TTY). In
non-interactive/piped mode it falls through to the original error message.

## Shell behavior

On Windows, `ashlr__bash` uses **PowerShell** (`pwsh` if available, otherwise `powershell`)
instead of `/bin/sh`. This means:

- Commands like `ls`, `cat`, `rm` use their PowerShell aliases, not POSIX tools.
- If you need POSIX shell behavior, install [Git for Windows](https://git-scm.com) and
  set `SHELL=C:\Program Files\Git\bin\bash.exe` in your environment.

## Key file permissions (genome encryption)

On POSIX systems, `~/.ashlr/team-keys/*.key` files are protected with `chmod 0600`.
On Windows, NTFS does not support POSIX ACLs. ashlr-plugin logs a one-time warning
and continues — the file is written but not restricted at the OS level.

Recommended mitigations (choose one):

- **BitLocker**: Encrypt the entire volume containing your user profile.
- **Windows EFS**: Right-click `%USERPROFILE%\.ashlr\team-keys\` in Explorer,
  Properties > Advanced > Encrypt contents.
- **Dedicated protected directory**: Move key storage to a BitLocker-protected
  secondary drive or VeraCrypt container.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `irm ... \| iex` blocked by execution policy | Run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` first, then re-run |
| `bun: command not found` after auto-install | Open a new terminal — PATH updates require a new session |
| `git: command not found` | Install [Git for Windows](https://git-scm.com/download/win) and ensure it's on PATH |
| `rg: command not found` | Install via `winget install BurntSushi.ripgrep.MSVC` or skip (`ashlr__grep` falls back gracefully) |
| Hook errors mentioning `bash` | Ensure hooks.json points at `.ts` files (not `.sh`). Run `bun run scripts/doctor.ts` |
| Key file warning on every session | Expected on Windows — see "Key file permissions" above |

## WSL (optional)

If you prefer a full Linux environment, install ashlr-plugin inside
[WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) using `install.sh`.
The TypeScript hooks work in WSL without any changes.
