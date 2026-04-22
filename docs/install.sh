#!/usr/bin/env bash
# ashlr-plugin one-liner installer.
#
# Usage:
#   curl -fsSL https://plugin.ashlr.ai/install.sh | bash
#
# What it does (idempotent — safe to re-run):
#   1. Checks bun is installed (links to install if missing)
#   2. Clones the plugin repo into Claude Code's marketplace cache
#   3. Runs `bun install` so MCP servers have their deps
#   4. Tells you the exact two slash-commands to run inside Claude Code
#
# Does NOT modify your Claude Code settings.json. Does NOT install globally.
# Everything lives in ~/.claude/plugins/cache/.

set -euo pipefail

cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }

cyan "ashlr-plugin installer · github.com/ashlrai/ashlr-plugin"
echo

# 1. Prerequisite: bun
if ! command -v bun >/dev/null 2>&1; then
  yellow "⚠  bun is not installed."
  # Offer auto-install when stdin is a terminal (skip in piped/non-interactive mode).
  if [ -t 0 ]; then
    printf "   Install Bun now via curl -fsSL bun.sh/install | bash? (Y/n) "
    read -r _bun_answer </dev/tty
    case "${_bun_answer:-Y}" in
      [Yy]|"")
        yellow "→ Running Bun installer..."
        curl -fsSL https://bun.sh/install | bash
        # Source the profile additions the Bun installer wrote.
        for _rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
          # shellcheck disable=SC1090
          [ -f "$_rc" ] && . "$_rc" 2>/dev/null || true
        done
        # Also update PATH directly for this shell session.
        export PATH="$HOME/.bun/bin:$PATH"
        if ! command -v bun >/dev/null 2>&1; then
          red "✗ Bun was installed but is not on PATH yet."
          echo "  Open a new terminal and re-run this script."
          exit 1
        fi
        green "✓ Bun installed successfully."
        ;;
      *)
        red "✗ bun is not installed."
        echo "  Install it first: https://bun.sh  (curl -fsSL https://bun.sh/install | bash)"
        echo "  ashlr-plugin's MCP servers run under bun."
        exit 1
        ;;
    esac
  else
    yellow "⚠  bun is not installed — skipping cache pre-warm."
    echo "  This installer will still finish cloning + printing next steps."
    echo "  bun will be auto-installed when the MCP server starts for the first time."
    echo "  (Set ASHLR_NO_AUTO_INSTALL=1 to opt out.)"
    _skip_bun_install=1
  fi
fi
if [ -z "${_skip_bun_install:-}" ]; then
  green "✓ bun $(bun --version)"
fi

# 2. Prerequisite: git + gh or raw clone access
if ! command -v git >/dev/null 2>&1; then
  red "✗ git is not installed."
  exit 1
fi
green "✓ git $(git --version | awk '{print $3}')"

# 3. Pre-clone into Claude Code's cache dir so /plugin install is instant
CACHE_DIR="$HOME/.claude/plugins/cache/ashlr-marketplace/ashlr"
mkdir -p "$(dirname "$CACHE_DIR")"

if [ -d "$CACHE_DIR/.git" ]; then
  yellow "→ Cache exists — updating"
  git -C "$CACHE_DIR" fetch --quiet origin main
  git -C "$CACHE_DIR" reset --quiet --hard origin/main
else
  yellow "→ Cloning plugin to $CACHE_DIR"
  git clone --quiet https://github.com/ashlrai/ashlr-plugin.git "$CACHE_DIR"
fi
green "✓ plugin at: $CACHE_DIR"

# 3b. Prune stale sibling cache versions (keep only the latest semver dir).
# Claude Code's marketplace cache sometimes accumulates old <X.Y.Z>/ dirs
# next to the active one. Keep only the newest.
SIBLING_PARENT="$(dirname "$CACHE_DIR")"
if [ -d "$SIBLING_PARENT" ]; then
  # Collect semver-shaped siblings, sort with -V, drop the latest, rm the rest.
  # shellcheck disable=SC2012
  mapfile -t _semver_dirs < <(
    ls -1 "$SIBLING_PARENT" 2>/dev/null \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
      | sort -V || true
  ) || _semver_dirs=()
  if [ "${#_semver_dirs[@]}" -gt 1 ]; then
    _latest="${_semver_dirs[-1]}"
    for _v in "${_semver_dirs[@]}"; do
      if [ "$_v" != "$_latest" ]; then
        yellow "→ Removing stale cache version: $_v"
        rm -rf "${SIBLING_PARENT:?}/${_v}"
      fi
    done
    green "✓ kept only latest cache version: $_latest"
  fi
fi

# 4. Install dependencies (skipped when bun isn't present — the MCP bootstrap
# will auto-install bun + run `bun install` itself on first spawn).
if [ -z "${_skip_bun_install:-}" ]; then
  yellow "→ Installing dependencies (bun install)"
  (cd "$CACHE_DIR" && bun install --silent 2>&1 | tail -5 || true)
  green "✓ dependencies installed"
else
  yellow "→ Skipping bun install — will run on first MCP server spawn"
fi

echo
cyan "Done. Next steps — inside Claude Code:"
echo
echo "  /plugin marketplace add ashlrai/ashlr-plugin"
echo "  /plugin install ashlr@ashlr-marketplace"
echo
echo "Then restart Claude Code. The baseline scanner runs on session start,"
echo "the tool-redirect hook fires on Read/Grep/Edit, and /ashlr-savings"
echo "shows totals."
echo
green "▶ Start here (after restart):"
echo "  /ashlr:ashlr-tour   — 2-minute guided tour of every tool, hook, and command"
echo
cyan "Landing page: https://plugin.ashlr.ai/"
cyan "Source:       https://github.com/ashlrai/ashlr-plugin"
