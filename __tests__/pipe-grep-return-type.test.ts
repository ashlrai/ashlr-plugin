// Keeps docs/pipe-grep-return-type.md in sync with the example query and the
// string return type documented by servers/pipe-server-handlers.ts.

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const DOC = new URL("../docs/pipe-grep-return-type.md", import.meta.url);
const HANDLER = new URL("../servers/pipe-server-handlers.ts", import.meta.url);

async function advertisedExample(): Promise<string> {
  const source = await readFile(HANDLER, "utf8");
  const expr = source.match(/Example: `([^`]+)`/)?.[1];
  if (!expr) throw new Error("Missing advertised example in pipe-server-handlers.ts");
  return expr;
}

async function docBlocks() {
  const doc = await readFile(DOC, "utf8");
  const blocks = [...doc.matchAll(/```(json|text)\n([\s\S]*?)\n```/g)];
  expect(blocks.map((block) => block[1])).toEqual(["json", "text", "json"]);
  return { doc, blocks };
}

async function withGrepFixture(
  run: (
    evaluate: (expr: string, output: string) => Promise<{ text: string }>,
    calls: Record<string, unknown>[],
  ) => Promise<void>,
) {
  const registry = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  let output = "";
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
    await run(
      async (expr, fixture) => {
        output = fixture;
        return ashlrPipe({ expr }, { sessionId: "pipe-grep-return-type", env: {} });
      },
      calls,
    );
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("the doc reproduces the handler-advertised example query verbatim", async () => {
  const [advertised, { blocks }] = await Promise.all([advertisedExample(), docBlocks()]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  expect(expr).toBe(advertised);

  await withGrepFixture(async (evaluate, calls) => {
    await evaluate(expr, "my project/notes.md:7:TODO later\n");
    expect(calls).toEqual([{ pattern: "TODO", cwd: "my project" }]);
  });
});

test("the doc states the handler's documented string return type", async () => {
  const [source, { doc }] = await Promise.all([readFile(HANDLER, "utf8"), docBlocks()]);
  // The doc wraps prose, so compare with whitespace collapsed.
  const flat = doc.replace(/\s+/g, " ");
  for (const phrase of [
    "returns the grep tool's text output as a string",
    "may include status messages",
  ]) {
    expect(source).toContain(phrase);
    expect(flat).toContain(phrase);
  }
  expect(doc).toContain("{ content: [{ type: \"text\", text }] }");
});

test("the documented query returns grep output as a JSON string", async () => {
  const { blocks } = await docBlocks();
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  // The doc's worked response must be the JSON encoding of its fixture text.
  const illustrated = `${blocks[1][2]}\n`;
  expect(JSON.parse(blocks[2][2])).toBe(illustrated);

  await withGrepFixture(async (evaluate, calls) => {
    const result = await evaluate(expr, illustrated);
    expect(result.text).toBe(blocks[2][2]);
    expect(result.text).toBe(JSON.stringify(illustrated));
    expect(JSON.parse(result.text)).toBe(illustrated);
    expect(typeof JSON.parse(result.text)).toBe("string");

    // Inside the expression the documented type really is a string.
    const inner = await evaluate(
      "return typeof (await ctx.grep({pattern:'TODO',cwd:'my project'}));",
      illustrated,
    );
    expect(JSON.parse(inner.text)).toBe("string");

    // "May include status messages" — every text shape passes through as a string.
    for (const output of [
      "",
      "[no matches]\n",
      "status: search unavailable\n",
      "[ashlr] genome may be stale (3 grep queries fell through to ripgrep).\n",
    ]) {
      const res = await evaluate(expr, output);
      expect(res.text).toBe(JSON.stringify(output));
      expect(JSON.parse(res.text)).toBe(output);
    }
    expect(calls).toEqual(Array(6).fill({ pattern: "TODO", cwd: "my project" }));
  });
});

test("the docs index lists the return-type page", async () => {
  const readme = await readFile(new URL("../docs/README.md", import.meta.url), "utf8");
  expect(readme).toContain("[`pipe-grep-return-type.md`](pipe-grep-return-type.md)");
});
