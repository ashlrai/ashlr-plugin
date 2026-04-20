/**
 * Router / _tool-base crash-isolation contract.
 *
 * A single handler's thrown exception must not propagate past the dispatch
 * boundary. The caller gets a structured `isError: true` response and the
 * observability channel records a `tool_crashed` event. Sibling handlers
 * registered alongside the faulty one must remain responsive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  __resetRegistryForTests,
  getTool,
  registerTool,
  type ToolCallContext,
  type ToolResult,
} from "../servers/_tool-base";

// Re-derive the same dispatcher _tool-base.runStandalone installs, so we can
// exercise the crash-catch branch without spawning an MCP stdio process.
async function dispatch(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { logEvent } = await import("../servers/_events");
  const tool = getTool(name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  const ctx: ToolCallContext = {
    sessionId: process.env.CLAUDE_SESSION_ID || process.env.ASHLR_SESSION_ID || undefined,
    env: process.env,
  };
  try {
    const result = (await tool.handler(args, ctx)) as ToolResult;
    return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    await logEvent("tool_crashed", {
      tool: tool.name,
      reason: msg,
      extra: stack ? { stack: stack.split("\n").slice(0, 5).join("\n") } : undefined,
    }).catch(() => undefined);
    return {
      content: [{ type: "text", text: `[ashlr:${tool.name}] handler crashed: ${msg}` }],
      isError: true,
    };
  }
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-crash-"));
  process.env.HOME = home;
  process.env.ASHLR_STATS_SYNC = "1";
  process.env.ASHLR_SESSION_LOG = "1";
  await mkdir(join(home, ".ashlr"), { recursive: true });
  __resetRegistryForTests();
});

afterEach(async () => {
  __resetRegistryForTests();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("_tool-base · per-handler crash isolation", () => {
  test("a throwing handler returns isError=true instead of propagating", async () => {
    registerTool({
      name: "ashlr__boom",
      description: "test handler that throws",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("kaboom");
      },
    });

    const result = await dispatch("ashlr__boom", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ashlr__boom");
    expect(result.content[0]!.text).toContain("crashed");
    expect(result.content[0]!.text).toContain("kaboom");
  });

  test("sibling handlers remain responsive after a peer crashes", async () => {
    registerTool({
      name: "ashlr__boom",
      description: "throws",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("boom");
      },
    });
    registerTool({
      name: "ashlr__ok",
      description: "returns fine",
      inputSchema: { type: "object" },
      handler: async () => ({ content: [{ type: "text", text: "hello" }] }),
    });

    const bad = await dispatch("ashlr__boom", {});
    expect(bad.isError).toBe(true);

    const good = await dispatch("ashlr__ok", {});
    expect(good.isError).toBeFalsy();
    expect(good.content[0]!.text).toBe("hello");
  });

  test("crashes emit a tool_crashed event to the session log", async () => {
    registerTool({
      name: "ashlr__boom",
      description: "throws",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("observable failure");
      },
    });

    await dispatch("ashlr__boom", {});

    // Session log is append-only JSONL; scan for the tool_crashed record.
    const logFile = join(home, ".ashlr", "session-log.jsonl");
    // Allow the best-effort append to flush.
    await Bun.sleep(20);
    const raw = await readFile(logFile, "utf-8").catch(() => "");
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const crashEvents = events.filter((e: any) => e.event === "tool_crashed");
    expect(crashEvents.length).toBeGreaterThan(0);
    const last = crashEvents[crashEvents.length - 1];
    expect(last.tool).toBe("ashlr__boom");
    expect(last.reason).toBe("observable failure");
  });

  test("non-Error throws still produce a structured response", async () => {
    registerTool({
      name: "ashlr__weird",
      description: "throws a string",
      inputSchema: { type: "object" },
      handler: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string";
      },
    });

    const result = await dispatch("ashlr__weird", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("raw string");
  });
});
