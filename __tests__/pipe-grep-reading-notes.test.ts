import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { __restoreRegistryForTests, __snapshotRegistryForTests, registerTool } from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

test("reading notes match both source examples and their string result", async () => {
  const [notes, guide, handler, index] = await Promise.all([
    readFile(new URL("../docs/pipe-grep-reading-notes.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8"),
    readFile(new URL("../servers/pipe-server-handlers.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/README.md", import.meta.url), "utf8"),
  ]);
  const blocks = [...notes.matchAll(/```(json|text)\n([\s\S]*?)\n```/g)];
  expect(blocks.map((block) => block[1])).toEqual(["json", "text", "json"]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  const section = guide.split("### Return grep output from a working directory\n")[1]?.split("\n### ")[0];
  const request = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  const advertised = handler.match(/Example: `([^`]+)`/)?.[1];
  if (!request || !advertised) throw new Error("Missing source example");
  expect(expr).toBe((JSON.parse(request) as { expr: string }).expr);
  expect(expr.replace(/\s+/g, "")).toBe(advertised.replace(/\s+/g, ""));
  expect(notes).toContain("(ashlr-pipe.md#return-grep-output-from-a-working-directory)");
  expect(notes).toContain("(../servers/pipe-server-handlers.ts)");
  expect(index).toContain("(pipe-grep-reading-notes.md)");

  const fixture = `${blocks[1][2]}\n`;
  expect(JSON.parse(blocks[2][2])).toBe(fixture);
  const calls: Record<string, unknown>[] = [];
  const registry = __snapshotRegistryForTests();
  try {
    registerTool({
      name: "ashlr__grep", description: "fixture", inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: fixture }] };
      },
    });
    const result = await ashlrPipe({ expr }, { sessionId: "pipe-reading-notes", env: {} });
    expect(result.text).toBe(blocks[2][2]);
    expect(typeof JSON.parse(result.text)).toBe("string");
    expect(calls).toEqual([{ pattern: "TODO", cwd: "my project" }]);
  } finally {
    __restoreRegistryForTests(registry);
  }
});
