/**
 * efficiency-server-handlers — side-effect module.
 *
 * Importing this file registers the five efficiency-server tools (ashlr__read,
 * ashlr__grep, ashlr__edit, ashlr__flush, ashlr__savings) into the shared
 * registry (_tool-base.ts). Logic still lives in efficiency-server.ts during
 * the v1.12 → v1.13 migration window; this module is a thin adapter so the
 * same tools can be dispatched through the router process.
 *
 * The standalone entry point (efficiency-server.ts) keeps its own Server /
 * setRequestHandler wiring for stale plugin.json entries. Once every
 * migrated-tool plugin.json entry is collapsed into a single router entry,
 * the standalone wiring can be deleted.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import {
  ashlrRead,
  ashlrGrep,
  ashlrEdit,
  flushPending,
  renderSavings,
  type EditArgs,
} from "./efficiency-server";
import { readStats, readCurrentSession } from "./_stats";
import {
  buildTopProjects,
  readCalibrationState,
  type ExtraContext,
} from "../scripts/savings-report-extras";
import { readNudgeSummary } from "./_nudge-events";
import { isProSync } from "./_pro";

// ---------------------------------------------------------------------------
// ashlr__read
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__read",
  description:
    "Read a file with automatic snipCompact truncation for results > 2KB. " +
    "Preserves head + tail, elides middle. Lower-token alternative to the " +
    "built-in Read tool.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative file path" },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization, return snipCompact-truncated content (default: false)",
      },
    },
    required: ["path"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrRead({
      path: String(args.path ?? ""),
      bypassSummary: args.bypassSummary === true,
    });
    return { content: [{ type: "text", text }] };
  },
});

// ---------------------------------------------------------------------------
// ashlr__grep
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__grep",
  description:
    "Search for a pattern. When a .ashlrcode/genome/ directory exists, uses " +
    "genome-aware retrieval to return only the most relevant sections. Falls " +
    "back to ripgrep otherwise.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Query or regex" },
      cwd: { type: "string", description: "Working directory (default: process.cwd())" },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization, return rg output as-is (default: false)",
      },
    },
    required: ["pattern"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrGrep({
      pattern: String(args.pattern ?? ""),
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      bypassSummary: args.bypassSummary === true,
    });
    return { content: [{ type: "text", text }] };
  },
});

// ---------------------------------------------------------------------------
// ashlr__edit
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__edit",
  description:
    "Apply a search/replace edit in-place and return only a diff summary. In " +
    "strict mode (default), requires exactly one match for safety. Set " +
    "strict:false to replace all occurrences.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative file path" },
      search: { type: "string", description: "Exact text to find" },
      replace: { type: "string", description: "Replacement text" },
      strict: { type: "boolean", description: "Require exactly one match (default: true)" },
    },
    required: ["path", "search", "replace"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const res = await ashlrEdit(args as unknown as EditArgs);
    return { content: [{ type: "text", text: res.text }] };
  },
});

// ---------------------------------------------------------------------------
// ashlr__flush
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__flush",
  description:
    "Flush all queued ashlr__edit writes to disk immediately and return a " +
    "summary of what was committed. Use when you need to read a file you just " +
    "edited, or at the end of a multi-edit sequence.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const summary = await flushPending();
    return {
      content: [{ type: "text", text: summary || "[ashlr__flush] nothing to flush" }],
    };
  },
});

// ---------------------------------------------------------------------------
// ashlr__savings
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__savings",
  description: "Return estimated tokens saved in the current session and lifetime totals.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const stats = await readStats();
    const session = await readCurrentSession();
    const topProjects = buildTopProjects();
    const { ratio: calibrationRatio, present: calibrationPresent } = readCalibrationState();
    const nudgeSummary = await readNudgeSummary();
    const proUser = isProSync();
    const extra: ExtraContext = { topProjects, calibrationRatio, calibrationPresent, nudgeSummary, proUser };
    return {
      content: [{ type: "text", text: renderSavings(session, stats.lifetime, extra) }],
    };
  },
});
