import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

test("documented ctx.grep call preserves blank lines and line boundaries", async () => {
  const source = await readFile(new URL("../servers/pipe-server-handlers.ts", import.meta.url), "utf8");
  const expr = source.match(/Example: `([^`]+)`/)?.[1];
  expect(expr).toBeDefined();

  const parts = ["\nmy project/a.ts:1:TODO first\n\n", "\nmy project/b.ts:2:TODO second\n\n"];
  const calls: Record<string, unknown>[] = [];
  const registry = __snapshotRegistryForTests();
  try {
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: parts.map((text) => ({ type: "text" as const, text })) };
      },
    });
    const result = await ashlrPipe({ expr: expr! }, { sessionId: "grep-blank-lines", env: {} });
    const output = JSON.parse(result.text);
    expect(typeof output).toBe("string");
    expect(output).toBe(parts.join(""));
    expect(output.split("\n")).toEqual([
      "", "my project/a.ts:1:TODO first", "", "", "my project/b.ts:2:TODO second", "", "",
    ]);
    expect(calls).toEqual([{ pattern: "TODO", cwd: "my project" }]);
  } finally {
    __restoreRegistryForTests(registry);
  }
});
