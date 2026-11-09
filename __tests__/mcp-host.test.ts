/**
 * mcp-host.test.ts — tests for multi-host MCP detection.
 *
 * servers/_mcp-host.ts decides whether Claude-Code-specific side effects
 * (~/.claude writes, hook firing, status-line nudges) may run. Wrong
 * detection either corrupts another host's config or silently disables
 * features for Claude Code users, and every gate funnels through these
 * three pure functions — which had no test file.
 */
import { describe, expect, test } from "bun:test";
import { detectMcpHost, isClaudeCodeHost, skipClaudeCodeSideEffects, type McpHost } from "../servers/_mcp-host.ts";

const ALL_HOSTS: McpHost[] = [
  "claude-code", "cline", "claude-desktop", "codex-cli", "gemini-cli", "cursor", "generic",
];

describe("detectMcpHost", () => {
  test("an explicit ASHLR_MCP_HOST wins for every known host", () => {
    for (const host of ALL_HOSTS) {
      expect(detectMcpHost({ ASHLR_MCP_HOST: host })).toBe(host);
    }
  });

  test("explicit values are trimmed and case-normalized", () => {
    expect(detectMcpHost({ ASHLR_MCP_HOST: "  Codex-CLI " })).toBe("codex-cli");
    expect(detectMcpHost({ ASHLR_MCP_HOST: "Cursor" })).toBe("cursor");
  });

  test("an unrecognized explicit value falls through to inference, not an error", () => {
    expect(detectMcpHost({ ASHLR_MCP_HOST: "vscode" })).toBe("generic");
  });

  test("Claude Code signals infer claude-code when the env var is unset", () => {
    expect(detectMcpHost({ CLAUDE_SESSION_ID: "s-1" })).toBe("claude-code");
    expect(detectMcpHost({ CLAUDE_PLUGIN_ROOT: "/plugins/ashlr" })).toBe("claude-code");
    expect(detectMcpHost({ CLAUDE_CODE_MODEL: "opus" })).toBe("claude-code");
  });

  test("blank Claude Code signals do not infer claude-code", () => {
    expect(detectMcpHost({ CLAUDE_SESSION_ID: "   " })).toBe("generic");
    expect(detectMcpHost({ CLAUDE_PLUGIN_ROOT: "" })).toBe("generic");
  });

  test("a hostless environment resolves to generic", () => {
    expect(detectMcpHost({})).toBe("generic");
  });

  test("an explicit non-CC host beats Claude Code signals", () => {
    expect(detectMcpHost({ ASHLR_MCP_HOST: "cline", CLAUDE_SESSION_ID: "s-1" })).toBe("cline");
  });
});

describe("isClaudeCodeHost / skipClaudeCodeSideEffects", () => {
  test("isClaudeCodeHost is true only for claude-code", () => {
    for (const host of ALL_HOSTS) {
      expect(isClaudeCodeHost({ ASHLR_MCP_HOST: host })).toBe(host === "claude-code");
    }
  });

  test("side effects are skipped for every non-CC host", () => {
    for (const host of ALL_HOSTS) {
      expect(skipClaudeCodeSideEffects({ ASHLR_MCP_HOST: host })).toBe(host !== "claude-code");
    }
  });

  test("an unset env var keeps the Claude Code default when a CC signal is present", () => {
    // The "existing installs keep their behavior" path relies on Claude Code
    // always exporting at least one of these; with no signal at all the
    // resolver is generic and CC side effects stay off.
    expect(isClaudeCodeHost({ CLAUDE_SESSION_ID: "abc" })).toBe(true);
    expect(skipClaudeCodeSideEffects({ CLAUDE_SESSION_ID: "abc" })).toBe(false);
    expect(skipClaudeCodeSideEffects({})).toBe(true);
  });
});
