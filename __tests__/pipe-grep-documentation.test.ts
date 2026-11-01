/**
 * pipe-grep-documentation.test.ts — guards the grep examples in
 * docs/ashlr-pipe.md against the string-returning interface implemented by
 * servers/pipe-server-handlers.ts:
 *
 *   - ctx.grep resolves to the wrapped tool's text output as a plain string
 *     (callTool() in servers/pipe-server.ts joins content[].text), and
 *   - the registered ashlr__pipe handler returns that string JSON-serialized
 *     inside { content: [{ type: "text", text }] }.
 *
 * The handler only registers when ASHLR_PIPE_ENABLE=1 at import time, so the
 * registration-path assertions run in a spawned process with a temp HOME —
 * the same pattern router-lazy-handshake.test.ts uses for gated modules.
 */

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { timingBudgetMs } from "../scripts/timing-budget.ts";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const ROOT = resolve(import.meta.dir, "..");
const DOC_HEADING = "Return grep output from a working directory";

interface HandlerReport {
  description: string;
  doc: { isError?: boolean; content: Array<{ type: string; text: string }> };
  ad: { isError?: boolean; content: Array<{ type: string; text: string }> };
  flow: { isError?: boolean; content: Array<{ type: string; text: string }> };
  walkthrough: { isError?: boolean; content: Array<{ type: string; text: string }> };
  bad: { isError?: boolean; content: Array<{ type: string; text: string }> };
  calls: Record<string, unknown>[];
}

async function documentedExpression(): Promise<{ section: string; expr: string }> {
  const guide = await readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8");
  const section = guide.split(`### ${DOC_HEADING}\n`)[1]?.split("\n### ")[0];
  if (!section) throw new Error(`Missing section: ${DOC_HEADING}`);
  const request = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!request) throw new Error(`Missing JSON example: ${DOC_HEADING}`);
  return { section, expr: (JSON.parse(request) as { expr: string }).expr };
}

async function advertisedExpression(): Promise<string> {
  const source = await readFile(
    new URL("../servers/pipe-server-handlers.ts", import.meta.url),
    "utf8",
  );
  const expr = source.match(/Example: `([^`]+)`/)?.[1];
  if (!expr) throw new Error("Missing advertised example in pipe-server-handlers.ts");
  return expr;
}

async function withGrepFixture(
  output: string,
  run: (
    evaluate: (expr: string) => Promise<unknown>,
    calls: Record<string, unknown>[],
  ) => Promise<void>,
) {
  const registry = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: output }] };
      },
    });
    await run(async (expr) => {
      const result = await ashlrPipe(
        { expr },
        { sessionId: "pipe-grep-documentation", env: {} },
      );
      return JSON.parse(result.text);
    }, calls);
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("documented grep example uses the string-returning ctx.grep interface", async () => {
  const { section, expr } = await documentedExpression();
  // The doc advertises a string return, not a ToolResult-shaped object.
  expect(section).toContain("ctx.grep` returns the grep tool's text output as a string");
  expect(expr).toContain("ctx.grep(");

  const output = "[ashlr__grep] status: ok\nmy project/file.ts:1:TODO first\n";
  await withGrepFixture(output, async (evaluate, calls) => {
    const result = await evaluate(expr);
    expect(typeof result).toBe("string");
    expect(result).toBe(output);
    expect(calls).toEqual([{ pattern: "TODO", cwd: "my project" }]);
  });
});

test("handler-advertised grep example is the documented string-returning call", async () => {
  const [advertised, { expr }] = await Promise.all([
    advertisedExpression(),
    documentedExpression(),
  ]);
  // The handler description and the guide document the same call — only the
  // whitespace inside the args object differs.
  expect(advertised.replace(/\s+/g, "")).toBe(expr.replace(/\s+/g, ""));

  const output = "my project/notes.md:7:TODO later\n";
  await withGrepFixture(output, async (evaluate, calls) => {
    expect(await evaluate(advertised)).toBe(output);
    expect(await evaluate(expr)).toBe(output);
    expect(calls).toEqual([
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: "my project" },
    ]);
  });
});

test("registered handler returns the documented grep result as text content", async () => {
  const home = await mkdtemp(join(tmpdir(), "ashlr-pipe-doc-"));
  try {
    const [{ expr }, advertised, flowGuide, walkthrough] = await Promise.all([
      documentedExpression(),
      advertisedExpression(),
      readFile(new URL("../docs/pipe-example-data-flow.md", import.meta.url), "utf8"),
      readFile(new URL("../docs/pipe-grep-example-walkthrough.md", import.meta.url), "utf8"),
    ]);
    const walkthroughRequest = walkthrough.match(/```json\n([\s\S]*?)\n```/)?.[1];
    if (!walkthroughRequest) throw new Error("Missing walkthrough request");
    const walkthroughExpr = (JSON.parse(walkthroughRequest) as { expr: string }).expr;
    const blocks = [...flowGuide.matchAll(/^\s*```(json|text)\n([\s\S]*?)^\s*```/gm)];
    expect(blocks.map((block) => block[1])).toEqual(["json", "text", "json"]);
    const flowRequest = JSON.parse(blocks[0][2]) as { expr: string };
    const output = blocks[1][2].replace(/^   /gm, "");
    const expectedFlowResponse = JSON.parse(blocks[2][2]);
    expect(flowRequest.expr).toBe(expr);
    expect(expectedFlowResponse.content[0].text).toBe(JSON.stringify(output));

    const script = [
      'const { registerTool, getTool } = await import("./servers/_tool-base.ts");',
      'await import("./servers/pipe-server-handlers.ts");',
      `const output = ${JSON.stringify(output)};`,
      "const calls = [];",
      'registerTool({ name: "ashlr__grep", description: "stub", inputSchema: {},',
      "  handler: async (args) => {",
      "    calls.push(args);",
      '    return { content: [{ type: "text", text: output }] };',
      "  } });",
      'const tool = getTool("ashlr__pipe");',
      'if (!tool) throw new Error("ashlr__pipe was not registered under ASHLR_PIPE_ENABLE=1");',
      'const ctx = { sessionId: "pipe-grep-doc-spawn", env: {} };',
      // Small timeout_ms: ashlrPipe leaves the deadline timer pending after the
      // race resolves, so the default 10s timeout would hold this process open.
      `const doc = await tool.handler({ expr: ${JSON.stringify(expr)}, timeout_ms: 500 }, ctx);`,
      `const ad = await tool.handler({ expr: ${JSON.stringify(advertised)}, timeout_ms: 500 }, ctx);`,
      `const flow = await tool.handler({ expr: ${JSON.stringify(flowRequest.expr)}, timeout_ms: 500 }, ctx);`,
      `const walkthrough = await tool.handler({ expr: ${JSON.stringify(walkthroughExpr)}, timeout_ms: 500 }, ctx);`,
      'const bad = await tool.handler({ expr: "return (" }, ctx);',
      "process.stdout.write(JSON.stringify({ description: tool.description, doc, ad, flow, walkthrough, bad, calls }));",
      "await new Promise((resolve) => setTimeout(resolve, 30));",
      "process.exit(0);",
    ].join("\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_PIPE_ENABLE: "1",
        ASHLR_STATS_SYNC: "1",
        ASHLR_SESSION_LOG: "0",
        ASHLR_CONTEXT_DB_DISABLE: "1",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout) as HandlerReport;

    // The registered description advertises the same string-returning example.
    expect(report.description).toContain("Example: `return await ctx.grep(");
    expect(report.description).toContain(
      "returns the grep tool's text output as a string",
    );

    // Both documented spellings of the grep example come back through the
    // handler's text-content interface as a JSON string.
    for (const result of [report.doc, report.ad]) {
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      expect(JSON.parse(result.content[0].text)).toBe(output);
    }
    expect(report.flow).toEqual(expectedFlowResponse);
    expect(report.walkthrough.isError).toBeUndefined();
    expect(report.walkthrough.content).toHaveLength(1);
    expect(report.walkthrough.content[0].type).toBe("text");
    expect(JSON.parse(report.walkthrough.content[0].text)).toEqual([
      "my project/file.ts:1", "status: done",
    ]);
    expect(report.calls).toEqual([
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: ".", bypassSummary: true },
    ]);

    // The error path returns the same string-text shape via toErrorResult.
    expect(report.bad.isError).toBe(true);
    expect(report.bad.content[0].type).toBe("text");
    expect(report.bad.content[0].text).toStartWith("ashlr__pipe error: ");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, timingBudgetMs(10_000));
