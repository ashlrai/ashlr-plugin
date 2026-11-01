import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ashlrPipe } from "../servers/pipe-server";
import { __restoreRegistryForTests, __snapshotRegistryForTests, registerTool } from "../servers/_tool-base";

test("documented grep text and derived file-and-line output match the pipe examples", async () => {
  const [doc, guide, handler] = await Promise.all([
    readFile(new URL("../docs/pipe-example-output-shape.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8"),
    readFile(new URL("../servers/pipe-server-handlers.ts", import.meta.url), "utf8"),
  ]);
  const directExpr = handler.match(/Example: `([^`]+)`/)?.[1];
  expect(directExpr).toBeDefined();
  expect(doc).toContain(`\`${directExpr}\``);
  const section = guide.split("### Example 1 — grep for TODOs, return file:line pairs")[1]?.split("### Example 2")[0];
  expect(section).toBeDefined();
  const { expr } = JSON.parse(section!.match(/```json\n([\s\S]*?)\n```/)![1]) as { expr: string };
  const sample = doc.match(/```text\n([\s\S]*?)\n```/)![1] + "\n";
  const documented = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)![1]);

  const snapshot = __snapshotRegistryForTests();
  let output = sample;
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep", description: "stub", inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: output }] };
      },
    });
    const ctx = { sessionId: "pipe-output-shape-test", env: process.env };
    const run = async (body: string) => (await ashlrPipe({ expr: body }, ctx)).text;
    expect(JSON.parse(await run(directExpr!))).toBe(sample);
    expect(JSON.parse(await run(expr))).toEqual(documented);
    expect(calls).toEqual([
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: ".", bypassSummary: true },
    ]);

    output = "";
    expect(JSON.parse(await run(expr))).toEqual([]);
    output = "[no matches]\n";
    expect(JSON.parse(await run(expr))).toEqual([]);
    output = "status: unavailable\ndrive:src/app.ts:3:TODO\n";
    expect(JSON.parse(await run(expr))).toEqual(["status: unavailable", "drive:src/app.ts"]);
    output = Array.from({ length: 22 }, (_, i) => `src/${i}.ts:${i + 1}:TODO`).join("\n");
    expect(JSON.parse(await run(expr))).toEqual(
      Array.from({ length: 20 }, (_, i) => `src/${i}.ts:${i + 1}`),
    );
  } finally {
    __restoreRegistryForTests(snapshot);
  }
});
