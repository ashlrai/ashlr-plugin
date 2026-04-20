/**
 * diff-semantic-server-handlers — registers ashlr__diff_semantic on the shared registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrDiffSemantic, type SemanticDiffArgs } from "./diff-semantic-server";

registerTool({
  name: "ashlr__diff_semantic",
  description:
    "AST-aware (heuristic) git diff summarization. A 200-line rename-refactor across 20 files renders as one line. Detects: symbol renames across >= 3 files, signature-only changes, formatting-only diffs. Degrades gracefully to compact diff output when no semantic patterns are found. Use instead of ashlr__diff when reviewing refactors, renames, or large reformatting commits.",
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
    },
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await ashlrDiffSemantic((args ?? {}) as SemanticDiffArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `ashlr__diff_semantic error: ${message}` }],
        isError: true,
      };
    }
  },
});
