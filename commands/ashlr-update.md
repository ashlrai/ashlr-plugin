---
name: ashlr-update
description: Update the ashlr-plugin to the latest version from its git remote.
---

Update the installed plugin in place.

Steps:

1. Run via Bash:

   ```
   cd ~/.claude/plugins/ashlr-plugin && git rev-parse --is-inside-work-tree
   ```

   - If this fails (not a git checkout — e.g. installed via tarball), tell the
     user: "ashlr-plugin is not installed as a git checkout. Re-run
     `/plugin marketplace add` (or reinstall from the marketplace) to upgrade,
     then restart Claude Code." Stop here.

2. Capture the pre-update SHA:

   ```
   cd ~/.claude/plugins/ashlr-plugin && git rev-parse --short HEAD
   ```

3. Pull and reinstall:

   ```
   cd ~/.claude/plugins/ashlr-plugin && git pull --ff-only && bun install
   ```

   - If `git pull --ff-only` fails because of local changes, surface the error
     verbatim and stop — do not attempt to `git reset` or stash. Tell the user
     to resolve manually.

4. Capture the post-update SHA and the changelog:

   ```
   cd ~/.claude/plugins/ashlr-plugin && git rev-parse --short HEAD
   cd ~/.claude/plugins/ashlr-plugin && git log --oneline HEAD@{1}..HEAD
   ```

5. Report:

   ```
   ashlr-plugin updated: <old-sha> → <new-sha>
   Changes:
     <oneline log, or "already up to date">
   Restart Claude Code (or reload the plugin) for the new version to take effect.
   ```

If the SHAs are equal, just print `ashlr-plugin already up to date at <sha>.`
and skip the restart prompt.
