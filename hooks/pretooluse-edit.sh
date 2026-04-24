#!/usr/bin/env bash
# ashlr-plugin PreToolUse:Edit enforcement hook.
#
# Blocks the built-in Edit tool on files larger than 5KB and redirects the
# agent to ashlr__edit, which applies an in-place strict-by-default
# search/replace and returns only a compact diff summary — saves ~80% tokens
# vs shipping the full before+after file contents.
#
# Contract (Claude Code PreToolUse):
#   stdin  → JSON { tool_name, tool_input: { file_path, ... }, ... }
#   exit 0 → allow the built-in call
#   exit 2 → block; stderr is shown to the agent as a tool error
#
# Exceptions (pass-through):
#   - File < 5 KB (round-trip cost is small)
#   - File does not exist (new-file creation via Edit is a rare/edge path;
#     pass through rather than block a legitimate create)
#   - Path is inside this plugin's own source tree
#   - $ASHLR_NO_ENFORCE=1
#   - tool_input.bypassSummary === true

set -u

THRESHOLD=5120

# Enforcement off by default; see pretooluse-read.sh for the full rationale.
# Day-to-day nudging/redirecting is handled by the .ts replacement
# (pretooluse-edit.ts); this .sh stays as a fallback for bun-less shells.
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
      const fp = typeof input.file_path === "string" ? input.file_path : "";
      const bypass = input.bypassSummary === true ? "1" : "0";
      process.stdout.write(`${name}\t${fp}\t${bypass}`);
    } catch {
      process.stdout.write("\t\t0");
    }
  });
' 2>/dev/null)

TOOL_NAME="${PARSED%%$'\t'*}"
REST="${PARSED#*$'\t'}"
FILE_PATH="${REST%%$'\t'*}"
BYPASS="${REST##*$'\t'}"

if [ "$TOOL_NAME" != "Edit" ]; then
  exit 0
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

if [ "$BYPASS" = "1" ]; then
  exit 0
fi

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$FILE_PATH" in
  "$PLUGIN_ROOT"/*) exit 0 ;;
esac

if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)

if [ -z "$SIZE" ] || [ "$SIZE" -le "$THRESHOLD" ] 2>/dev/null; then
  exit 0
fi

cat >&2 <<EOF
ashlr: refusing full Edit on large file $FILE_PATH ($SIZE bytes). Call ashlr__edit with diff-format to save ~80% tokens. Set ASHLR_NO_ENFORCE=1 to disable this guard.
EOF
exit 2
