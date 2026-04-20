/**
 * bash-server-handlers — registers the five bash tools on the shared registry.
 *
 * `reloadSessions()` still runs at bash-server.ts module import time (required
 * to restore persisted background sessions on startup), so importing this
 * module side-effect also boots session restoration.
 */

import { registerTool, toErrorResult, type ToolCallContext, type ToolResult } from "./_tool-base";
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
    "Run a shell command. Auto-compresses stdout > 2KB (head + tail with elided middle), and emits compact structured summaries for common commands (git status, ls, find, ps, npm ls). stderr is never compressed. Refuses catastrophic patterns and `cat <file>` (use ashlr__read instead). Lower-token alternative to the built-in Bash tool.",
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
    "Spawn a long-running shell command in the background and return a session id. Use ashlr__bash_tail to poll incremental output, ashlr__bash_stop to kill, ashlr__bash_list to enumerate. Ideal for watchers, tails, long builds, and anything where streaming >> one-shot.",
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
    "Read new stdout/stderr since the last poll for a background session. Auto-compresses the tail window when > 2KB. If wait_ms > 0, blocks (event-driven) until output arrives or the process exits, up to that ceiling.",
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
    try {
      const text = await ashlrBashList();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toErrorResult(ERR_PREFIX, err);
    }
  },
});
