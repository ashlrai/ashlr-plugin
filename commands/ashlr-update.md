---
name: ashlr-update
description: Update the ashlr-plugin to the latest version from its git remote.
---

Update the installed plugin in place.

The install location differs by Claude Code version:

- **New layout** (most users): `~/.claude/plugins/cache/<marketplace>/ashlr/<version>/`
- **Legacy layout**: `~/.claude/plugins/ashlr-plugin/`
- **Dev install**: `$CLAUDE_PLUGIN_ROOT` (set when running from a local checkout)

Resolve the actual path before doing anything else.

Steps:

1. **Resolve the install path.** Run via Bash, picking the first candidate that
   is a git checkout:

   ```bash
   PLUGIN_DIR=""
   for candidate in \
     "${CLAUDE_PLUGIN_ROOT:-}" \
     "$HOME/.claude/plugins/ashlr-plugin" \
     "$(ls -d $HOME/.claude/plugins/cache/*/ashlr/*/ 2>/dev/null | tail -1)"; do
     [ -z "$candidate" ] && continue
     if [ -d "$candidate/.git" ]; then PLUGIN_DIR="$candidate"; break; fi
   done
   echo "PLUGIN_DIR=$PLUGIN_DIR"
   ```

   - If `PLUGIN_DIR` is empty, tell the user: "ashlr-plugin is not installed as
     a git checkout. Re-run `/plugin marketplace add` (or reinstall from the
     marketplace) to upgrade, then restart Claude Code." Stop here.
   - If multiple cache directories exist (old `0.7.0/` plus a newer versioned
     dir), the `tail -1` picks the most recent lexicographically — which is
     usually correct. If that turns out wrong, pass the path yourself.

2. **Capture the pre-update SHA:**

   ```bash
   git -C "$PLUGIN_DIR" rev-parse --short HEAD
   ```

3. **Pull and reinstall:**

   ```bash
   git -C "$PLUGIN_DIR" pull --ff-only && (cd "$PLUGIN_DIR" && bun install)
   ```

   - If `git pull --ff-only` fails because of local changes, surface the error
     verbatim and stop — do not attempt to `git reset` or stash. Tell the user
     to resolve manually.

4. **Capture the post-update SHA and the changelog:**

   ```bash
   git -C "$PLUGIN_DIR" rev-parse --short HEAD
   git -C "$PLUGIN_DIR" log --oneline HEAD@{1}..HEAD
   ```

5. **Report:**

   ```
   ashlr-plugin updated: <old-sha> → <new-sha>
   Changes:
     <oneline log, or "already up to date">
   Restart Claude Code (or reload the plugin) for the new version to take effect.
   ```

If the SHAs are equal, just print `ashlr-plugin already up to date at <sha>.`
and skip the restart prompt.

### Note on Claude Code's plugin cache

The cache directory is named after the version at *install* time (e.g.
`ashlr/0.7.0/`), and that directory name does **not** change when you pull
newer commits into it via this skill. The path is effectively opaque — treat
it as the plugin's git checkout, not a version indicator. Claude Code's
marketplace loader reads `package.json` / `.claude-plugin/plugin.json` inside
the checkout, so the version it reports will reflect the pulled HEAD, not the
directory name.
