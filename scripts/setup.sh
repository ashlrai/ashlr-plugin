#!/usr/bin/env bash
# Install ashlr-plugin dependencies and run the tool smoke check.
# Safe to run again. No prompts. macOS and Linux.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

os="$(uname -s)"
case "$os" in
  Darwin|Linux) ;;
  *)
    printf 'scripts/setup.sh supports macOS and Linux. This machine reports %s.\n' "$os" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js is required. Install it, then run bash scripts/setup.sh again.\n' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    printf 'Bun is not on PATH and curl is missing, so the installer cannot run.\n' >&2
    exit 1
  fi
  printf 'Bun is not on PATH. Installing it with the official installer.\n'
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'Bun is still not on PATH. Add "$HOME/.bun/bin" to PATH, then run bash scripts/setup.sh again.\n' >&2
  exit 1
fi

bun install --frozen-lockfile
bun run smoke:tools
