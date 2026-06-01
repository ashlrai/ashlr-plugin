#!/usr/bin/env bash
# Publish ashlr-plugin to GitHub (public) and enable Pages for the /docs site.
# Also publishes @ashlr/core-efficiency if the sibling repo exists locally and
# hasn't been pushed yet. Safe to re-run — each step is a no-op if already done.
#
# Requires: gh CLI authed (gh auth status).
# Usage: ./scripts/publish.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }

run() {
  cyan "\$ $*"
  if [ "$DRY_RUN" -eq 0 ]; then eval "$@"; fi
}

if ! command -v gh >/dev/null; then
  red "gh CLI not installed. https://cli.github.com"
  exit 1
fi

gh auth status >/dev/null 2>&1 || { red "gh not authed. Run: gh auth login"; exit 1; }
USER=$(gh api user --jq .login)
green "Authed as: $USER"
echo

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$(cd "$STACK_DIR/../ashlr-core-efficiency" 2>/dev/null && pwd || true)"

# --- 0. Pre-flight: verify the public manifests agree on the version ---
yellow "→ Checking version manifest sync…"
if ! (cd "$STACK_DIR" && bun run version:check); then
  red "Version manifests are out of sync. Run: bun run version:bump <new-version>"
  exit 1
fi
echo

# --- 1. Publish @ashlr/core-efficiency (public) ---
if [ -n "$CORE_DIR" ] && [ -d "$CORE_DIR/.git" ]; then
  cd "$CORE_DIR"
  if ! git remote get-url origin >/dev/null 2>&1; then
    yellow "→ ashlr-core-efficiency has no remote. Creating…"
    run "gh repo create $USER/ashlr-core-efficiency --public --source . --description 'Token-efficiency primitives for Claude Code: genome, compression, provider-aware budgeting.' --push"
  else
    green "✓ ashlr-core-efficiency already has remote: $(git remote get-url origin)"
    run "git push -u origin main 2>/dev/null || git push"
  fi
else
  yellow "⚠ skipping ashlr-core-efficiency — sibling repo not found at $STACK_DIR/../ashlr-core-efficiency"
fi
echo

# --- 2. Publish ashlr-plugin ---
cd "$STACK_DIR"
if ! git remote get-url origin >/dev/null 2>&1; then
  yellow "→ ashlr-plugin has no remote. Creating…"
  run "gh repo create $USER/ashlr-plugin --public --source . --description 'Open-source Claude Code plugin — token-efficient Read/Grep/Edit via @ashlr/core-efficiency. MIT.' --push"
else
  green "✓ ashlr-plugin already has remote: $(git remote get-url origin)"
  run "git push -u origin main 2>/dev/null || git push"
fi
echo

# --- 3. Enable GitHub Pages from /docs ---
yellow "→ Enabling GitHub Pages from /docs folder…"
PAGES_JSON=$(cat <<EOF
{"source":{"branch":"main","path":"/docs"}}
EOF
)
run "gh api -X POST /repos/$USER/ashlr-plugin/pages --input - <<< '$PAGES_JSON' 2>/dev/null || gh api -X PUT /repos/$USER/ashlr-plugin/pages --input - <<< '$PAGES_JSON' 2>/dev/null || echo '(pages may already be enabled)'"
echo

# --- 4. Report final URLs ---
green "Done."
echo "  Plugin repo:        https://github.com/$USER/ashlr-plugin"
echo "  Landing page:       https://plugin.ashlr.ai/"
echo "  Core library repo:  https://github.com/$USER/ashlr-core-efficiency"
echo
yellow "Install inside Claude Code:"
echo "  /plugin marketplace add $USER/ashlr-plugin"
echo "  /plugin install ashlr@ashlr-marketplace"
