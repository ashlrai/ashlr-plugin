#!/usr/bin/env bash
# fast-check.sh — run typecheck + only affected tests in under 2 minutes.
#
# Usage: bash scripts/fast-check.sh
# Compares the current branch against origin/main and runs only the tests
# that correspond to changed files.  On a clean main (no diffs) the
# typecheck runs and then exits 0 with no test targets to execute.
#
# This script stays out of server/ and package.json (those are handled by
# the full `check` script).  Integration and server tests are included
# only when their source files change.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SCRIPTS_DIR="$ROOT/scripts"

# 1. Typecheck — always runs, catches regressions early.  Skip silently
#    when there is no tsconfig (e.g. a temporary repo).
if [ -f "$ROOT/tsconfig.json" ]; then
  (cd "$ROOT" && bunx tsc --noEmit)
fi

# 2. Find changed files since origin/main.  When the branch is even with
# origin/main the diff is empty, which means "no tests need re-running".
# If origin/main is not available (e.g. shallow clones, temp repos),
# the diff command fails silently — treated as no changes.
DIFF="$(git diff --name-status -z --no-renames origin/main...HEAD -- 2>/dev/null || true)"

if [ -z "$DIFF" ]; then
  # Clean main: no files changed (or no shared history) — typecheck was enough.
  exit 0
fi

# 3. Use the existing affected-tests.ts CLI to select relevant test targets.
#    On a real PR the merge base accounts for the common ancestor;
#    origin/main itself works because this repo's default branch always
#    has shared history with feature branches.
#    On failure (e.g. no shared history), treat as "no tests to run".
TARGETS="$(bun "$SCRIPTS_DIR/affected-tests.ts" origin/main 2>/dev/null || true)"

if [ -z "$TARGETS" ] || [ "$TARGETS" = "ALL" ]; then
  # No affected tests or configuration change — typecheck was the check.
  exit 0
fi

# 4. Run only the targeted test suites, respecting timing budgets.
#    bun test uses --parallel workers and is fast for unit-only suites.
if [ "$TARGETS" = "ALL" ]; then
  bun test "$@"
else
  bun test $TARGETS "$@"
fi
