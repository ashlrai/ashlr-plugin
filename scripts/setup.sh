#!/usr/bin/env bash
# macOS and Linux entry. The setup itself is node, so Windows can run it too.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
exec node scripts/setup.mjs
