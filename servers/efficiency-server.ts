#!/usr/bin/env bun
/**
 * ashlr-efficiency MCP server.
 *
 * Exposes token-efficient replacements for Claude Code's built-in file tools:
 *   - ashlr__read  - snipCompact on file contents > 2KB
 *   - ashlr__grep  - genome-aware retrieval when .ashlrcode/genome/ exists,
 *                    ripgrep fallback otherwise
 *   - ashlr__edit  - diff-format edits that avoid sending full file contents
 *
 * Also tracks estimated tokens saved, persisted at ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { readStats, readCurrentSession } from "./_stats";

import { buildTopProjects, readCalibrationState, type ExtraContext } from "../scripts/savings-report-extras";

import { readNudgeSummary } from "./_nudge-events";
import { isProSync } from "./_pro";

import { ashlrRead, ashlrEdit, flushPending, type EditArgs } from "./efficiency-files";
import { ashlrGrep } from "./efficiency-search";
import { renderSavings } from "./efficiency-savings";
import { costFor } from "./_pricing";
export { ashlrRead, ashlrEdit, flushPending, type EditArgs, type EditResult } from "./efficiency-files";
export { ashlrGrep } from "./efficiency-search";
export { PRICING, SAVINGS_BANNER, renderColoredBanner, renderSavings } from "./efficiency-savings";

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-efficiency", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__read",
      description: "Read a file with automatic snipCompact truncation for results > 2KB. Preserves head + tail, elides middle. Lower-token alternative to the built-in Read tool.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          bypassSummary: { type: "boolean", description: "Skip LLM summarization, return snipCompact-truncated content (default: false)" },
        },
        required: ["path"],
      },
    },
    {
      name: "ashlr__grep",
      description: "Search for a pattern. When a .ashlrcode/genome/ directory exists, uses genome-aware retrieval to return only the most relevant sections. Falls back to ripgrep otherwise.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Query or regex" },
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
          bypassSummary: { type: "boolean", description: "Skip LLM summarization, return rg output as-is (default: false)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "ashlr__edit",
      description: "Apply a search/replace edit in-place and return only a diff summary. In strict mode (default), requires exactly one match for safety. Set strict:false to replace all occurrences.",
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
    },
    {
      name: "ashlr__flush",
      description: "Flush all queued ashlr__edit writes to disk immediately and return a summary of what was committed. Use when you need to read a file you just edited, or at the end of a multi-edit sequence.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ashlr__savings",
      description: "Return estimated tokens saved in the current session and lifetime totals.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "ashlr__read": {
        const text = await ashlrRead(args as { path: string; bypassSummary?: boolean });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__grep": {
        const text = await ashlrGrep(args as { pattern: string; cwd?: string; bypassSummary?: boolean });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__edit": {
        const res = await ashlrEdit(args as unknown as EditArgs);
        return { content: [{ type: "text", text: res.text }] };
      }
      case "ashlr__flush": {
        const summary = await flushPending();
        return { content: [{ type: "text", text: summary || "[ashlr__flush] nothing to flush" }] };
      }
      case "ashlr__savings": {
        const stats = await readStats();
        const session = await readCurrentSession();
        const topProjects = buildTopProjects(
          process.env.HOME ?? process.env.USERPROFILE,
        );
        const { ratio: calibrationRatio, present: calibrationPresent } = readCalibrationState();
        const nudgeSummary = await readNudgeSummary();
        const proUser = isProSync();
        const lifetimeDollarsSaved = costFor(stats.lifetime.tokensSaved);
        const extra: ExtraContext = { topProjects, calibrationRatio, calibrationPresent, nudgeSummary, proUser, lifetimeDollarsSaved };
        return {
          content: [{ type: "text", text: renderSavings(session, stats.lifetime, extra) }],
        };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
