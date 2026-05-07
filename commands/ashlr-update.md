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

3. **Pull and reinstall.** Run as a single bash block so the auto-recovery
   logic stays atomic:

   ```bash
   git -C "$PLUGIN_DIR" fetch --quiet 2>&1
   PULL_OUT=$(git -C "$PLUGIN_DIR" pull --ff-only 2>&1)
   PULL_RC=$?

   if [ $PULL_RC -ne 0 ] && echo "$PULL_OUT" | grep -q "would be overwritten by merge"; then
     # Conflict shape: "Your local changes to the following files would be
     # overwritten by merge:" + tab-indented file list + "Please commit ...".
     # Extract the file list, then split into:
     #   SAFE   — files that are gitignored at the upstream HEAD post-pull
     #            (proof the project no longer tracks them — runtime mutations
     #            are pure cruft, safe to discard)
     #   UNSAFE — anything else (real source-file conflicts the user must
     #            resolve themselves)
     CONFLICTS=$(echo "$PULL_OUT" | awk '/would be overwritten/{flag=1; next} /^Please/{flag=0} flag' | sed 's/^[[:space:]]*//' | sed '/^$/d')
     UPSTREAM_IGNORE=$(git -C "$PLUGIN_DIR" show "@{u}:.gitignore" 2>/dev/null)

     SAFE=""
     UNSAFE=""
     while IFS= read -r f; do
       [ -z "$f" ] && continue
       if echo "$UPSTREAM_IGNORE" | grep -qFx "$f"; then
         SAFE="$SAFE $f"
       else
         UNSAFE="$UNSAFE $f"
       fi
     done <<< "$CONFLICTS"

     if [ -n "$UNSAFE" ]; then
       echo "$PULL_OUT"
       echo ""
       echo "Files with local changes that aren't safe to auto-discard:"
       for f in $UNSAFE; do echo "  $f"; done
       echo ""
       echo "Resolve manually, then re-run /ashlr-update."
       exit 1
     fi

     echo "Auto-resetting runtime-only files (now gitignored upstream):"
     for f in $SAFE; do echo "  $f"; done
     git -C "$PLUGIN_DIR" checkout -- $SAFE
     git -C "$PLUGIN_DIR" pull --ff-only 2>&1 | tail -5
   elif [ $PULL_RC -ne 0 ]; then
     echo "$PULL_OUT"
     exit 1
   fi

   (cd "$PLUGIN_DIR" && bun install 2>&1 | tail -3)
   ```

   Why the auto-recovery: the plugin's own genome subsystem (PostToolUse
   `genome-auto-propose` + SessionEnd consolidator) appends to runtime files
   inside the plugin checkout. When the upstream commit moves those files into
   `.gitignore`, any locally-mutated copy will block `git pull --ff-only` even
   though the content is throwaway hook output. The whitelist is "in upstream's
   `.gitignore`" — that's the project's explicit signal that the file is not
   source content. Anything outside that whitelist still surfaces verbatim, so
   real conflicts (a user's hand-edits to the plugin code) never get clobbered.

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

   ⚠ MCP servers run from the old code until you reload.
     Fastest:  run  /reload-plugins
     Full:     quit Claude Code and start a fresh session
   ```

   The warning is not optional — in-process MCP servers are long-lived child
   processes that Claude Code does NOT hot-reload after `git pull`. If the
   user keeps working without a reload, `ashlr__edit` / `ashlr__grep` / etc.
   will still be running the previous version's code even though the source
   on disk has moved forward.

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
