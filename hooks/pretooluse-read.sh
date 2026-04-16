#!/usr/bin/env bash
# ashlr-plugin PreToolUse:Read enforcement hook.
#
# Blocks the built-in Read tool on files larger than 2KB and redirects the
# agent to ashlr__read, which returns a snipCompact-truncated view (head +
# tail, elided middle) saving ~60-95% of tokens on large files.
#
# Contract (Claude Code PreToolUse):
#   stdin  → JSON { tool_name, tool_input: { file_path, ... }, ... }
#   exit 0 → allow the built-in call
#   exit 2 → block; stderr is shown to the agent as a tool error
#
# Exceptions (pass-through):
#   - File < 2 KB (no meaningful savings)
#   - File does not exist or cannot be stat'd (let built-in produce the real error)
#   - Path is inside this plugin's own source tree (dogfooding / self-edits)
#   - $ASHLR_NO_ENFORCE=1 (global escape hatch)
#   - tool_input.bypassSummary === true (explicit override by agent)
#
# Design notes:
#   - Uses `bun -e` for JSON parsing (bun is already a plugin dependency).
#   - Single stat call, no other subprocess work, typical runtime <30ms.

set -u

THRESHOLD=2048

# Global escape hatch.
if [ "${ASHLR_NO_ENFORCE:-0}" = "1" ]; then
  exit 0
fi

# Slurp stdin JSON; malformed or empty → pass-through.
STDIN_JSON=$(cat)
if [ -z "${STDIN_JSON// }" ]; then
  exit 0
fi

# Parse tool_name, file_path, bypassSummary via bun. Output is tab-separated:
#   <tool_name>\t<file_path>\t<bypassSummary>
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

# Only enforce on Read. Any other tool name → pass-through (defensive).
if [ "$TOOL_NAME" != "Read" ]; then
  exit 0
fi

# Missing or empty path → let built-in handle it.
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Explicit bypass by caller.
if [ "$BYPASS" = "1" ]; then
  exit 0
fi

# Plugin's own source tree is exempt (users editing the plugin itself).
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$FILE_PATH" in
  "$PLUGIN_ROOT"/*) exit 0 ;;
esac

# File must exist and be a regular file to enforce; else pass-through.
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Portable stat: macOS uses -f%z, Linux uses -c%s.
SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)

if [ -z "$SIZE" ] || [ "$SIZE" -le "$THRESHOLD" ] 2>/dev/null; then
  exit 0
fi

# Rough token-savings estimate: snipCompact keeps ~head+tail (~1KB), so savings
# are approximately (SIZE - 1024) / 4 tokens (4 bytes/token avg).
SAVED_BYTES=$(( SIZE - 1024 ))
SAVED_TOKENS=$(( SAVED_BYTES / 4 ))
if [ "$SAVED_TOKENS" -lt 0 ]; then SAVED_TOKENS=0; fi

# Block and redirect.
cat >&2 <<EOF
ashlr: refusing full Read of $FILE_PATH ($SIZE bytes). Call ashlr__read instead for snipCompact truncation — saves ~${SAVED_TOKENS} tokens. Pass bypassSummary: true on ashlr__read if you truly need the raw file. Set ASHLR_NO_ENFORCE=1 to disable this guard.
EOF
exit 2
