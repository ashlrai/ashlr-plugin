/**
 * genome-server-handlers — registers ashlr__genome_propose / _consolidate /
 * _status on the shared registry.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import {
  handlePropose,
  handleConsolidate,
  handleStatus,
  type ProposeArgs,
  type ConsolidateArgs,
  type StatusArgs,
} from "./genome-server";

const ERR_PREFIX = "ashlr-genome error";

registerTool({
  name: "ashlr__genome_propose",
  description:
    "Queue a proposed update to a named genome section. Fire-and-forget: the " +
    "proposal is appended to the pending queue and will be merged into the genome " +
    "on the next ashlr__genome_consolidate call. Use this to record project " +
    "decisions, new strategies, architectural discoveries, or lessons learned so " +
    "they persist across sessions.",
  inputSchema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description:
          "Section path relative to .ashlrcode/genome, e.g. 'knowledge/decisions.md' or 'strategies/active.md'",
      },
      content: {
        type: "string",
        description:
          "Proposed content (full section replace OR appended block; see 'operation')",
      },
      operation: {
        type: "string",
        enum: ["append", "update", "create"],
        description: "How to apply the content (default: append)",
      },
      rationale: {
        type: "string",
        description: "Why this change — 1-3 sentences",
      },
      cwd: {
        type: "string",
        description: "Override working directory (default: process.cwd())",
      },
    },
    required: ["section", "content", "rationale"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await handlePropose(args as unknown as ProposeArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__genome_consolidate",
  description:
    "Merge pending proposals into the genome. Without `model` (and without " +
    "$ASHLR_LLM_URL) runs a deterministic sequential-apply; with an " +
    "LLM configured by $ASHLR_LLM_URL it merges conflicting proposals " +
    "for the same section.",
  inputSchema: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description:
          "Pass 'none' to force offline sequential-apply, or any other value (for example 'llm') to merge with the LLM configured by $ASHLR_LLM_URL (default local LM Studio at 127.0.0.1:1234). The value is never used as an endpoint. If omitted, uses the LLM only when $ASHLR_LLM_URL or $ASHLR_LLM_KEY is set.",
      },
      cwd: {
        type: "string",
        description: "Override working directory",
      },
    },
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await handleConsolidate(args as unknown as ConsolidateArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__genome_status",
  description:
    "Show pending proposals and recent mutations for the current genome. Compact " +
    "report suitable for inline context.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: {
        type: "string",
        description: "Override working directory",
      },
    },
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await handleStatus(args as unknown as StatusArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});
