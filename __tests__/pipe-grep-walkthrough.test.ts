import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { __restoreRegistryForTests, __snapshotRegistryForTests, registerTool } from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

test("walkthrough request matches the advertised example and its documented string result", async () => {
  const [doc, handler, index] = await Promise.all([
    readFile(new URL("../docs/pipe-grep-walkthrough.md", import.meta.url), "utf8"),
    readFile(new URL("../servers/pipe-server-handlers.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/README.md", import.meta.url), "utf8"),
  ]);
  const blocks = [...doc.matchAll(/```(json|text)\n([\s\S]*?)\n```/g)];
  expect(blocks.map((b) => b[1])).toEqual(["json", "text", "json"]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  const advertised = handler.match(/Example: `([^`]+)`/)?.[1];
  if (!advertised) throw new Error("Missing advertised example");
  expect(expr.replace(/\s+/g, "")).toBe(advertised.replace(/\s+/g, ""));
  expect(doc).toContain("(ashlr-pipe.md#return-grep-output-from-a-working-directory)");
  expect(index).toContain("(pipe-grep-walkthrough.md)");

  const fixture = `${blocks[1][2]}\n`;
  const calls: Record<string, unknown>[] = [];
  const registry = __snapshotRegistryForTests();
  try {
    registerTool({
      name: "ashlr__grep", description: "fixture", inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: fixture.slice(0, 5) }, { type: "text", text: fixture.slice(5) }] };
      },
    });
    const result = await ashlrPipe({ expr }, { sessionId: "pipe-grep-walkthrough", env: {} });
    expect(result.text).toBe(blocks[2][2]);
    expect(JSON.parse(result.text)).toBe(fixture);
    expect(calls).toEqual([{ pattern: "TODO", cwd: "my project" }]);
  } finally {
    __restoreRegistryForTests(registry);
  }
});
