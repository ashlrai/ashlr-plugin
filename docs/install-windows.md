# Installing ashlr-plugin on Windows

ashlr-plugin runs on Windows with Node.js and [Bun for Windows](https://bun.sh/docs/installation#windows).
The host starts hooks through `node scripts/hook-bootstrap.mjs`, which resolves Bun
and runs the TypeScript hook files. No bash or POSIX shell is required.

## Prerequisites

1. **Node.js and npm** on PATH. The CLI, MCP server and hook launchers use Node.js.

2. **Bun for Windows** (1.3 or newer). The `ashlr-plugin` CLI requires an existing
   Bun installation; it never installs Bun itself. The MCP bootstrap can install
   Bun when the server starts, and the PowerShell cache installer installs it
   when missing.

   Manual install (only if you set `ASHLR_NO_AUTO_INSTALL=1` or want to pre-install):

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

3. **An MCP host**, such as Claude Code, Codex or Cursor. The cache installer below
   is specifically for Claude Code.

4. **Git for Windows**, required for the cache installer's clone and git-related
   tools (`ashlr__diff`, commit attribution).
   Download from [git-scm.com](https://git-scm.com/download/win).

5. **ripgrep** (`rg` on PATH), required for file searches with `ashlr__grep`.
   A missing executable produces an error with an install hint; it is not a
   successful search with no matches.

   ```powershell
   winget install BurntSushi.ripgrep.MSVC
   ```

### How Bun auto-install works

The Claude Code plugin manifest starts `node scripts/bootstrap.mjs`. The npm
`ashlr-mcp` launcher uses the same bootstrap. It checks for Bun on PATH and in
`%USERPROFILE%\.bun\bin` before downloading anything. If Bun is still missing,
it runs the Windows Bun installer, adds the default Bun directory to the child
process's PATH, and starts the MCP entrypoint.

Set `ASHLR_NO_AUTO_INSTALL=1` to disable the MCP bootstrap's download. It exits
with a manual-install message if Bun cannot be found. Hook launchers never
install Bun; if it is unavailable, they exit successfully without running the
hook. This flag does not disable the separate `docs/install.ps1` installer.

## Install

### CLI and MCP server

With Node.js and Bun available, install the npm package from PowerShell or cmd:

```powershell
npm install -g ashlr-plugin
ashlr-plugin tools --json
```

The second command should print an object with `schema`, `count` and `tools`.
Then add the [MCP configuration for your host](../README.md#mcp-server) and
restart the host. The savings ledger is `%USERPROFILE%\.ashlr\stats.json`.

### Claude Code plugin cache

Run this in PowerShell. It clones the plugin, installs dependencies and removes
older versioned cache directories. It does not install the npm CLI:

```powershell
irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
```

If Bun is not on PATH, the script installs it and continues. It does not ask.
It refreshes PATH in the current session and checks again. If Bun is still
unavailable, it exits with instructions to open a new terminal and retry.
To manage Bun yourself, install it before running this script.

The installer clones to:

```
%USERPROFILE%\.claude\plugins\cache\ashlr-marketplace\ashlr\<version>\
```

This matches the path Claude Code's marketplace flow expects, so `/plugin install` is
instant and re-runs update the active copy rather than creating orphan directories.

After the script completes, run these commands inside Claude Code:

```
/plugin marketplace add ashlrai/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
/reload-plugins
```

Then run `/ashlr-status`. If `/reload-plugins` is unavailable or the status
check does not see ashlr, fully quit and restart Claude Code.

## Migration note

If you previously installed with an older version of this script, you may have an orphan
copy at `%USERPROFILE%\.claude\plugins\ashlr-plugin\`. It is safe to delete that directory
manually after confirming it is unused by your host configuration.

## Shell behavior

On Windows, `ashlr__bash` uses **PowerShell** (`pwsh` if available, otherwise `powershell`)
with `-NoProfile -NonInteractive -Command`. This means:

- Commands like `ls`, `cat`, `rm` use their PowerShell aliases, not POSIX tools.
- `SHELL` only selects the shell on macOS and Linux. Setting it to Git Bash does
  not change the native Windows shell. For a POSIX environment, run the host
  and plugin inside WSL (see below).

## Key file permissions (genome encryption)

On POSIX systems, `~/.ashlr/team-keys/*.key` files are protected with `chmod 0600`.
On Windows, POSIX `chmod` mode bits do not set NTFS permissions. Each key file
inherits its parent directory's ACLs. ashlr-plugin emits a warning every time a
team key is written; it does not apply a Windows ACL itself.

Recommended mitigations (choose one):

- **BitLocker**: Encrypt the entire volume containing your user profile.
- **Windows EFS**: Right-click `%USERPROFILE%\.ashlr\team-keys\` in Explorer,
  Properties > Advanced > Encrypt contents.
- **Restrictive ACLs**: Check the key directory's inherited permissions. See
  [Windows key protection](platform-support.md#protecting-ashlrteam-keys-on-windows)
  for the permission checks and mitigations.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| PowerShell script blocked by local policy | Follow your organization's script policy, or use the npm CLI and MCP setup above |
| `bun: command not found` after auto-install | Open a new terminal and restart the host so both see the updated PATH |
| `git: command not found` | Install [Git for Windows](https://git-scm.com/download/win) and ensure it's on PATH |
| `rg: command not found` | Install via `winget install BurntSushi.ripgrep.MSVC`, then restart the host |
| Hook errors mentioning `bash` | Update the cached plugin; current hooks start through `node scripts/hook-bootstrap.mjs`. Run `/ashlr-doctor` inside Claude Code |
| Key file warning after saving a team key | Expected on Windows; check the inherited ACLs as described above |

## WSL (optional)

If you prefer a full Linux environment, install ashlr-plugin inside
[WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) using `install.sh`.
The TypeScript hooks work in WSL without any changes.
