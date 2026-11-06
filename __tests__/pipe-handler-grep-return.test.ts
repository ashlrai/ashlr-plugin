// Keeps docs/pipe-handler-grep-return.md in sync with the ctx.grep return
// type and minimal invocation documented by servers/pipe-server-handlers.ts.

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const DOC = new URL("../docs/pipe-handler-grep-return.md", import.meta.url);
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
        return ashlrPipe({ expr }, { sessionId: "pipe-handler-grep-return", env: {} });
      },
      calls,
    );
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("the doc reproduces the handler-advertised minimal invocation verbatim", async () => {
  const [advertised, { blocks }] = await Promise.all([advertisedExample(), docBlocks()]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  expect(expr).toBe(advertised);

  await withGrepFixture(async (evaluate, calls) => {
    await evaluate(expr, "src/app.ts:3:TODO fix this\n");
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

test("the doc claims no ctx capabilities beyond the handler's advertised set", async () => {
  const { doc } = await docBlocks();
  const advertised = new Set(["grep", "read", "ls", "glob", "bash"]);
  const mentioned = [...doc.matchAll(/ctx\.(\w+)/g)].map((m) => m[1]);
  expect(mentioned.length).toBeGreaterThan(0);
  for (const name of mentioned) {
    expect(advertised).toContain(name);
  }
});

test("the documented invocation returns grep output as a JSON string", async () => {
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

    // "May include status messages" — annotated output passes through as a string.
    const annotated = `${illustrated}[ashlr confidence: low · bypassSummary:true to recover fidelity]\n`;
    const res = await evaluate(expr, annotated);
    expect(res.text).toBe(JSON.stringify(annotated));
    expect(JSON.parse(res.text)).toBe(annotated);

    expect(calls).toEqual(Array(3).fill({ pattern: "TODO", cwd: "my project" }));
  });
});

test("the docs index lists the handler grep-return page", async () => {
  const readme = await readFile(new URL("../docs/README.md", import.meta.url), "utf8");
  expect(readme).toContain("[`pipe-handler-grep-return.md`](pipe-handler-grep-return.md)");
});
