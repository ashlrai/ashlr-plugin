/**
 * bash-server-handlers — registers the five bash tools on the shared registry.
 *
 * `reloadSessions()` still runs at bash-server.ts module import time (required
 * to restore persisted background sessions on startup), so importing this
 * module side-effect also boots session restoration.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
import { logEvent } from "./_events";
import {
  ashlrBash,
  ashlrBashStart,
  ashlrBashTail,
  ashlrBashStop,
  ashlrBashList,
  type BashArgs,
  type StartArgs,
  type TailArgs,
  type StopArgs,
} from "./bash-server";

const ERR_PREFIX = "ashlr__bash error";

registerTool({
  name: "ashlr__bash",
  description:
    "Run commands instead of native Bash for verbose output. Compresses stdout over 2 KB; stderr stays intact. Refuses catastrophic patterns. Use ashlr__read for cat.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      cwd: { type: "string", description: "Working directory (default: process.cwd())" },
      timeout_ms: { type: "number", description: "Kill after N ms (default 60000)" },
      compact: { type: "boolean", description: "Auto-compress long output (default true)" },
      bypassSummary: { type: "boolean", description: "Skip LLM summarization of long output" },
    },
    required: ["command"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await ashlrBash(args as unknown as BashArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__bash_start",
  description:
    "Start a background shell command and return a session ID. Use ashlr__bash_tail to poll, ashlr__bash_stop to kill and ashlr__bash_list to enumerate. Suits watchers and long builds.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      cwd: { type: "string", description: "Working directory (default: process.cwd())" },
      timeout_ms: { type: "number", description: "Max lifetime before SIGKILL (default 300000 = 5min)" },
    },
    required: ["command"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    void logEvent("tool_call", { tool: "ashlr__bash_start" });
    try {
      const text = await ashlrBashStart(args as unknown as StartArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__bash_tail",
  description:
    "Poll new background session stdout/stderr with compact output over 2 KB. Set wait_ms to wait for output or process exit, up to that duration.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Session id from ashlr__bash_start" },
      max_bytes: { type: "number", description: "Tail window size (default 2048)" },
      wait_ms: { type: "number", description: "Block up to N ms for new output (default 1500; 0 = return immediately)" },
    },
    required: ["id"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    void logEvent("tool_call", { tool: "ashlr__bash_tail" });
    try {
      const text = await ashlrBashTail(args as unknown as TailArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__bash_stop",
  description:
    "Kill a background session by id. Sends SIGTERM (configurable) and escalates to SIGKILL after 2s if still alive.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      signal: { type: "string", description: "Default SIGTERM; escalates to SIGKILL after 2s" },
    },
    required: ["id"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    void logEvent("tool_call", { tool: "ashlr__bash_stop" });
    try {
      const text = await ashlrBashStop(args as unknown as StopArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});

registerTool({
  name: "ashlr__bash_list",
  description: "List active background sessions: id | pid | started | cumulative bytes | command.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    void logEvent("tool_call", { tool: "ashlr__bash_list" });
    try {
      const text = await ashlrBashList();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});
