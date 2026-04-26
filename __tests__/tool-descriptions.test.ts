/**
 * tool-descriptions.test.ts — Track E v1.22
 *
 * Asserts that every registered ashlr tool has a description that:
 *   1. Is non-empty.
 *   2. Is at least 80 characters (enough to be meaningful).
 *   3. Contains the substring "instead of" (WHEN-to-use guidance per the
 *      Track E WHEN-to-use template).
 *   4. Is at most 500 characters (don't bloat the schema sent to the model).
 *
 * Also asserts on the redirect-block format from buildToolRedirectBlock:
 *   - Contains the full canonical MCP name (mcp__plugin_ashlr_ashlr__ashlr__*).
 *   - Contains an `args:` block with valid JSON.
 *   - The `bypass` instruction appears in the first 60 chars (v1.21 invariant).
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { listTools } from "../servers/_tool-base";
import { buildToolRedirectBlock } from "../hooks/pretooluse-common";

// ---------------------------------------------------------------------------
// Import all handler modules to trigger their registerTool() side effects.
// This mirrors what _router-handlers.ts does in production.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await import("../servers/_router-handlers");
});

// ---------------------------------------------------------------------------
// Tool description invariants
// ---------------------------------------------------------------------------

describe("tool descriptions — WHEN-to-use template", () => {
  test("all registered tools have a non-empty description", () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(
        tool.description,
        `${tool.name}: description must be non-empty`,
      ).toBeTruthy();
      expect(
        tool.description!.trim().length,
        `${tool.name}: description must not be blank`,
      ).toBeGreaterThan(0);
    }
  });

  test("all registered tools have a description of at least 80 chars", () => {
    const tools = listTools();
    const short = tools.filter((t) => (t.description ?? "").length < 80);
    if (short.length > 0) {
      const names = short.map((t) => `  ${t.name} (${(t.description ?? "").length} chars)`).join("\n");
      throw new Error(`Tools with description < 80 chars:\n${names}`);
    }
  });

  test("all registered tools have a description of at most 500 chars", () => {
    const tools = listTools();
    const long = tools.filter((t) => (t.description ?? "").length > 500);
    if (long.length > 0) {
      const names = long.map((t) => `  ${t.name} (${(t.description ?? "").length} chars)`).join("\n");
      throw new Error(`Tools with description > 500 chars:\n${names}`);
    }
  });

  // Only tools that have a native Claude Code equivalent must carry "instead of"
  // WHEN-to-use guidance. Tools like ashlr__savings, ashlr__genome_*, ashlr__ask
  // have no native counterpart and are exempt.
  const TOOLS_WITH_NATIVE_EQUIVALENT = new Set([
    "ashlr__read",
    "ashlr__grep",
    "ashlr__edit",
    "ashlr__multi_edit",
    "ashlr__edit_structural",
    "ashlr__diff",
    "ashlr__diff_semantic",
    "ashlr__search_replace_regex",
    "ashlr__bash",
    "ashlr__webfetch",
  ]);

  test("tools with native equivalents have 'instead of' in their description (WHEN-to-use guidance)", () => {
    const tools = listTools();
    const relevant = tools.filter((t) => TOOLS_WITH_NATIVE_EQUIVALENT.has(t.name));
    const missing = relevant.filter((t) => !(t.description ?? "").includes("instead of"));
    if (missing.length > 0) {
      const names = missing.map((t) => `  ${t.name}`).join("\n");
      throw new Error(
        `Tools missing "instead of" WHEN-to-use guidance:\n${names}\n\n` +
          `Each tool that replaces a native Claude Code tool must explain when to use it.`,
      );
    }
  });

  // Spot-check the edit family for decision-tree keywords so Claude can pick
  // correctly without reading all descriptions.
  test("ashlr__edit description mentions ashlr__multi_edit and ashlr__edit_structural", () => {
    const tools = listTools();
    const edit = tools.find((t) => t.name === "ashlr__edit");
    expect(edit, "ashlr__edit must be registered").toBeTruthy();
    expect(edit!.description).toContain("ashlr__multi_edit");
    expect(edit!.description).toContain("ashlr__edit_structural");
  });

  test("ashlr__multi_edit description mentions ashlr__edit", () => {
    const tools = listTools();
    const multi = tools.find((t) => t.name === "ashlr__multi_edit");
    expect(multi, "ashlr__multi_edit must be registered").toBeTruthy();
    expect(multi!.description).toContain("ashlr__edit");
  });

  test("ashlr__edit_structural description mentions ashlr__edit", () => {
    const tools = listTools();
    const structural = tools.find((t) => t.name === "ashlr__edit_structural");
    expect(structural, "ashlr__edit_structural must be registered").toBeTruthy();
    expect(structural!.description).toContain("ashlr__edit");
  });

  test("ashlr__diff description mentions ashlr__diff_semantic", () => {
    const tools = listTools();
    const diff = tools.find((t) => t.name === "ashlr__diff");
    expect(diff, "ashlr__diff must be registered").toBeTruthy();
    expect(diff!.description).toContain("ashlr__diff_semantic");
  });

  test("ashlr__search_replace_regex description mentions ashlr__edit and ashlr__edit_structural", () => {
    const tools = listTools();
    const srr = tools.find((t) => t.name === "ashlr__search_replace_regex");
    expect(srr, "ashlr__search_replace_regex must be registered").toBeTruthy();
    expect(srr!.description).toContain("ashlr__edit");
    expect(srr!.description).toContain("ashlr__edit_structural");
  });
});

// ---------------------------------------------------------------------------
// buildToolRedirectBlock format invariants (Track E v1.21/v1.22)
// ---------------------------------------------------------------------------

describe("buildToolRedirectBlock — redirect message format", () => {
  const EXAMPLE_BLOCK = buildToolRedirectBlock({
    mcpToolName: "mcp__plugin_ashlr_ashlr__ashlr__grep",
    argsJson: '{ "pattern": "foo.*bar", "path": "/repo/src" }',
    why: "native Grep returns ~10× more bytes; ashlr__grep is genome-aware.",
    savingsPct: 80,
  });

  const reason: string =
    EXAMPLE_BLOCK.hookSpecificOutput.permissionDecisionReason;

  test("output is a deny block", () => {
    expect(EXAMPLE_BLOCK.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(EXAMPLE_BLOCK.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  test("reason contains full canonical MCP tool name", () => {
    expect(reason).toContain("mcp__plugin_ashlr_ashlr__ashlr__grep");
  });

  test("reason contains an args: block with valid JSON", () => {
    // Must contain `args:` followed by a JSON object on the same line
    const argsMatch = reason.match(/args:\s*(\{[^}]+\})/);
    expect(argsMatch, "reason must contain 'args: { ... }'").toBeTruthy();
    // The matched JSON must parse without throwing
    const parsed = JSON.parse(argsMatch![1]!);
    expect(parsed).toBeTypeOf("object");
  });

  test("bypass instruction appears in the first 60 chars of reason (v1.21 invariant)", () => {
    expect(reason.slice(0, 60)).toContain("bypass");
  });

  test("reason contains the why line", () => {
    expect(reason).toContain("Why:");
    expect(reason).toContain("genome-aware");
  });

  test("reason contains the savings percentage", () => {
    expect(reason).toContain("80%");
  });

  // Verify the grep redirect block matches the spec example from the plan.
  test("spec example shape: tool_use + args + Why line", () => {
    expect(reason).toContain("tool_use:");
    expect(reason).toContain("args:");
    expect(reason).toContain("Why:");
  });

  // Regression: custom bypassNote propagates
  test("custom bypassNote is used when provided", () => {
    const block = buildToolRedirectBlock({
      mcpToolName: "mcp__plugin_ashlr_ashlr__ashlr__read",
      argsJson: '{ "path": "/x/y.ts" }',
      why: "saves tokens",
      savingsPct: 70,
      bypassNote: "pass bypassSummary:true",
    });
    const r = block.hookSpecificOutput.permissionDecisionReason;
    expect(r.slice(0, 60)).toContain("bypass");
    expect(r).toContain("pass bypassSummary:true");
  });
});
