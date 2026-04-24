#!/usr/bin/env bash
# ashlr-plugin PreToolUse:Grep enforcement hook.
#
# Blocks the built-in Grep tool and redirects the agent to ashlr__grep, which
# routes through genome-aware RAG (when .ashlrcode/genome/ exists) or a
# truncated ripgrep fallback — saves tokens on every project-level search.
#
# Contract (Claude Code PreToolUse):
#   stdin  → JSON { tool_name, tool_input: { pattern, path?, ... }, ... }
#   exit 0 → allow the built-in call
#   exit 2 → block; stderr is shown to the agent as a tool error
#
# Exceptions (pass-through):
#   - $ASHLR_NO_ENFORCE=1 (global escape hatch)
#   - tool_input.bypassSummary === true (explicit override)
#   - Search scoped entirely inside the plugin's own source tree
#
# Note: We always enforce on project-level Grep. ashlr__grep has a truncated
# rg fallback when no genome exists, so there is no "small project" exemption
# — raw rg output streams unbounded matches and is always wasteful relative
# to ashlr__grep.

set -u

# Enforcement off by default; see pretooluse-read.sh for the full rationale.
# Day-to-day nudging/redirecting is handled by the .ts replacement
# (pretooluse-grep.ts); this .sh stays as a fallback for bun-less shells.
if [ "${ASHLR_ENFORCE:-0}" != "1" ]; then
  exit 0
fi
if [ "${ASHLR_NO_ENFORCE:-0}" = "1" ]; then
  exit 0
fi

STDIN_JSON=$(cat)
if [ -z "${STDIN_JSON// }" ]; then
  exit 0
fi

PARSED=$(printf '%s' "$STDIN_JSON" | bun -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const p = JSON.parse(raw);
      const name = p?.tool_name ?? "";
      const input = p?.tool_input ?? {};
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const path = typeof input.path === "string" ? input.path : "";
      const bypass = input.bypassSummary === true ? "1" : "0";
      // Escape tabs/newlines in pattern so the shell split stays clean.
      const safe = pattern.replace(/[\t\n\r]/g, " ");
      process.stdout.write(`${name}\t${safe}\t${path}\t${bypass}`);
    } catch {
      process.stdout.write("\t\t\t0");
    }
  });
' 2>/dev/null)

IFS=$'\t' read -r TOOL_NAME PATTERN SEARCH_PATH BYPASS <<< "$PARSED"

if [ "$TOOL_NAME" != "Grep" ]; then
  exit 0
fi

if [ "${BYPASS:-0}" = "1" ]; then
  exit 0
fi

# Exempt searches confined to the plugin's own tree.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${SEARCH_PATH:-}" ]; then
  case "$SEARCH_PATH" in
    "$PLUGIN_ROOT"|"$PLUGIN_ROOT"/*) exit 0 ;;
  esac
fi

# Escape double-quotes and backslashes for the redirect message.
SAFE_PATTERN="${PATTERN//\\/\\\\}"
SAFE_PATTERN="${SAFE_PATTERN//\"/\\\"}"

cat >&2 <<EOF
ashlr: routing Grep through ashlr__grep for genome-aware retrieval (saves tokens when genome exists, truncates otherwise). Call ashlr__grep with pattern='${SAFE_PATTERN}'. Set ASHLR_NO_ENFORCE=1 to disable this guard.
EOF
exit 2
