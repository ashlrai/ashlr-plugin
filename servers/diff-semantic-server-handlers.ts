/**
 * diff-semantic-server-handlers — registers ashlr__diff_semantic on the shared registry.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrDiffSemantic, type SemanticDiffArgs } from "./diff-semantic-server";

registerTool({
  name: "ashlr__diff_semantic",
  description:
    "Summarize refactors instead of raw git diff with heuristic AST-aware rename, signature and formatting detection. Use instead of ashlr__diff for refactors; falls back to compact diff.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Working directory (default: process.cwd())" },
      range: {
        type: "string",
        description:
          "Git range to diff, e.g. 'HEAD~1..HEAD'. Default: unstaged working tree changes.",
      },
      staged: {
        type: "boolean",
        description: "If true, diff staged changes (--cached). Overrides range.",
      },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization of long semantic-diff output (default: false).",
      },
    },
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await ashlrDiffSemantic((args ?? {}) as SemanticDiffArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult("ashlr__diff_semantic error", err);
    }
  },
});
