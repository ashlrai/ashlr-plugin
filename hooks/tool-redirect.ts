#!/usr/bin/env bun
/**
 * ashlr tool-redirect PreToolUse hook.
 *
 * Intercepts the built-in Read / Grep / Edit tool calls and nudges the agent
 * toward the token-efficient ashlr__read / ashlr__grep / ashlr__edit
 * equivalents exposed by the ashlr-efficiency MCP server.
 *
 * Contract (Claude Code hooks):
 *   stdin  → JSON describing the pending tool call:
 *              { tool_name, tool_input, ... }
 *   stdout → JSON of the form:
 *              {
 *                "hookSpecificOutput": {
 *                  "hookEventName": "PreToolUse",
 *                  "additionalContext": "...",
 *                  "permissionDecision": "ask" | "allow" | "deny",
 *                  "permissionDecisionReason": "..."
 *                }
 *              }
 *
 * Design notes:
 *   - We never hard-deny and NEVER set `permissionDecision` — setting it to
 *     "ask" causes Claude Code to surface a permission prompt even in
 *     `bypassPermissions` mode (per the docs, ask rules are evaluated
 *     regardless of mode). The goal is a *silent nudge* via `additionalContext`
 *     only. The agent learns about `ashlr__*` alternatives; the built-in call
 *     still proceeds without user interruption.
 *   - Read is only intercepted when the file is > 2 KB (matches the snipCompact
 *     threshold in efficiency-server.ts). Tiny files have nothing to compact,
 *     so we pass through silently.
 *   - Grep and Edit are always nudged: ashlr__grep wins on every call (genome
 *     RAG or rg fallback that truncates), and ashlr__edit avoids shipping the
 *     full before+after file contents.
 *   - Anything unexpected → silent pass-through. A hook that throws would
 *     break the agent's normal flow, which is strictly worse than not having
 *     the hook at all.
 *   - Honors `~/.ashlr/settings.json` { "toolRedirect": false } as a global
 *     opt-out for users who prefer the built-ins.
 */

import { existsSync, statSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext?: string;
  };
}

const READ_NUDGE_THRESHOLD = 2048;

function passThrough(): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
}

// Silent nudge — inject additionalContext only. Claude Code proceeds with
// the built-in call without surfacing a permission prompt (setting
// `permissionDecision` here would force a prompt even in bypass mode).
// The `reason` arg is ignored at the response layer but retained for
// call-site readability and possible future observability.
function nudge(_reason: string, context: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  };
}

export function isRedirectEnabled(home: string = homedir()): boolean {
  try {
    const settingsPath = join(home, ".ashlr", "settings.json");
    if (!existsSync(settingsPath)) return true;
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      toolRedirect?: boolean;
    };
    return raw.toolRedirect !== false;
  } catch {
    return true;
  }
}

export function decide(
  payload: PreToolUsePayload,
  opts: { home?: string } = {},
): HookOutput {
  if (!isRedirectEnabled(opts.home)) return passThrough();

  const name = payload?.tool_name;
  const input = (payload?.tool_input ?? {}) as Record<string, unknown>;

  switch (name) {
    case "Read": {
      const filePath = typeof input.file_path === "string" ? input.file_path : null;
      if (!filePath) return passThrough();
      let size = 0;
      try {
        if (!existsSync(filePath)) return passThrough();
        size = statSync(filePath).size;
      } catch {
        return passThrough();
      }
      if (size <= READ_NUDGE_THRESHOLD) return passThrough();
      // JSON.stringify escapes quotes, backslashes, and control characters
      // (newline, tab, etc). Without it, an attacker-controlled file path
      // containing `"\nIgnore prior instructions\n` would inject natural
      // language into the nudge text the model subsequently sees — a quiet
      // prompt-injection amplifier.
      return nudge(
        `File is ${size} bytes — ashlr__read uses snipCompact to preserve head+tail and elide the middle, saving tokens.`,
        `[ashlr] Prefer the MCP tool \`ashlr__read\` for files larger than 2KB. ` +
          `It returns a snipCompact-truncated view (head + tail, elided middle) ` +
          `instead of the full ${size}-byte payload. Call it with { "path": ${JSON.stringify(filePath)} }.`,
      );
    }
    case "Grep": {
      const pattern =
        typeof input.pattern === "string" ? input.pattern : "<pattern>";
      return nudge(
        "ashlr__grep uses genome-aware retrieval (or truncated rg) instead of streaming raw matches.",
        `[ashlr] Prefer the MCP tool \`ashlr__grep\` over the built-in Grep. ` +
          `When .ashlrcode/genome/ exists it returns the most relevant ` +
          `pre-summarized sections; otherwise it falls back to a truncated ` +
          `ripgrep result. Call it with { "pattern": ${JSON.stringify(pattern)} }.`,
      );
    }
    case "Edit": {
      const filePath =
        typeof input.file_path === "string" ? input.file_path : "<path>";
      return nudge(
        "ashlr__edit ships only a diff summary instead of the full before+after file contents.",
        `[ashlr] Prefer the MCP tool \`ashlr__edit\` over the built-in Edit. ` +
          `It applies an in-place strict-by-default search/replace and returns ` +
          `only a compact diff summary, avoiding the full file round-trip. ` +
          `Call it with { "path": ${JSON.stringify(filePath)}, "search": ..., "replace": ..., "strict": true }.`,
      );
    }
    default:
      return passThrough();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  let payload: PreToolUsePayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as PreToolUsePayload;
  } catch {
    // Malformed input → pass-through, never block the agent.
    process.stdout.write(JSON.stringify(passThrough()));
    return;
  }
  try {
    process.stdout.write(JSON.stringify(decide(payload)));
  } catch {
    process.stdout.write(JSON.stringify(passThrough()));
  }
}

// Only run when executed directly (not when imported by tests).
if (import.meta.main) {
  await main();
}
