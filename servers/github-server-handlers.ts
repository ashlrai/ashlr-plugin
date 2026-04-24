/**
 * github-server-handlers — registers ashlr__pr, ashlr__issue, and the four
 * GitHub write-op tools (pr_comment, pr_approve, issue_create, issue_close)
 * on the shared router registry.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import {
  ashlrPr,
  ashlrIssue,
  ashlrPrComment,
  ashlrPrApprove,
  ashlrIssueCreate,
  ashlrIssueClose,
} from "./github-server";

const ERR_PREFIX = "ashlr error";

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
      return toErrorResult(ERR_PREFIX, err);
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
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__pr_comment",
  description:
    "Post a comment on a GitHub PR. Pass pr:\"current\" to target the PR for the checked-out branch. Returns the new comment URL.",
  inputSchema: {
    type: "object",
    properties: {
      pr: {
        description: "PR number or the string \"current\" to target the current branch's PR",
        oneOf: [{ type: "number" }, { type: "string", enum: ["current"] }],
      },
      body: { type: "string", description: "Comment body (markdown supported)" },
      repo: { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
      confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
    },
    required: ["pr", "body"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as { pr: number | string; body: string; repo?: string; confirm?: boolean };
      const text = await ashlrPrComment(a);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__pr_approve",
  description:
    "Approve a GitHub PR with an optional review body. Refuses to approve your own PR. Pass pr:\"current\" to target the PR for the checked-out branch.",
  inputSchema: {
    type: "object",
    properties: {
      pr: {
        description: "PR number or the string \"current\" to target the current branch's PR",
        oneOf: [{ type: "number" }, { type: "string", enum: ["current"] }],
      },
      body: { type: "string", description: "Optional review comment body" },
      repo: { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
      confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
    },
    required: ["pr"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as { pr: number | string; body?: string; repo?: string; confirm?: boolean };
      const text = await ashlrPrApprove(a);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__issue_create",
  description:
    "Create a new GitHub issue with title + body and optional labels/assignees. Returns the new issue number and URL.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body (markdown supported)" },
      labels: { type: "array", items: { type: "string" }, description: "Optional label names to apply" },
      assignees: { type: "array", items: { type: "string" }, description: "Optional GitHub logins to assign" },
      repo: { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
      confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
    },
    required: ["title", "body"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as {
        title: string;
        body: string;
        labels?: string[];
        assignees?: string[];
        repo?: string;
        confirm?: boolean;
      };
      const text = await ashlrIssueCreate(a);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__issue_close",
  description:
    "Close a GitHub issue with an optional closing comment and reason (completed|not_planned).",
  inputSchema: {
    type: "object",
    properties: {
      issue: { type: "number", description: "Issue number" },
      comment: { type: "string", description: "Optional closing comment" },
      reason: { type: "string", enum: ["completed", "not_planned"], description: "Optional close reason" },
      repo: { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
      confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
    },
    required: ["issue"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const a = args as {
        issue: number;
        comment?: string;
        reason?: string;
        repo?: string;
        confirm?: boolean;
      };
      const text = await ashlrIssueClose(a);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});
