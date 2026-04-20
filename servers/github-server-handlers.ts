/**
 * github-server-handlers — registers ashlr__pr and ashlr__issue on the shared registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrPr, ashlrIssue } from "./github-server";

registerTool({
  name: "ashlr__pr",
  description:
    "Fetch a GitHub PR and return a compact review-ready summary (header, reviews, unresolved comments, status checks). Read-only — never approves, comments, or merges. Saves 60-90% of the tokens a raw `gh pr view` dump would cost.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
      repo: { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
      mode: { type: "string", description: "'summary' (default: decisions + unresolved + checks) | 'full' (adds diff summary) | 'thread' (just comments)" },
    },
    required: ["number"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as { number: number; repo?: string; mode?: string };
      const text = await ashlrPr(a);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
    }
  },
});

registerTool({
  name: "ashlr__issue",
  description:
    "Fetch a GitHub issue and return a compact header + body + comment list. In 'thread' mode, each comment is rendered with snipCompact on > 500 char bodies. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
      repo: { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
      mode: { type: "string", description: "'summary' (default) | 'thread' (full comments with snipCompact on each)" },
    },
    required: ["number"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as { number: number; repo?: string; mode?: string };
      const text = await ashlrIssue(a);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
    }
  },
});
