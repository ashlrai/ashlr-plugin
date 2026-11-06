/**
 * pipe-server-grep-example.test.ts — verifies the ctx.grep example advertised
 * in the ashlr__pipe tool description in servers/pipe-server-handlers.ts:
 *
 *   Example: `return await ctx.grep({pattern:'TODO',cwd:'my project'});`
 *
 * The example names the pattern TODO and resolves to the grep tool's text
 * output as a string, which the pipe JSON-serializes inside text content.
 * docs/pipe-server-grep-example.md reproduces the call and its illustrated
 * response, so this file keeps the handler, the guide, and that page aligned.
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const HANDLER = new URL("../servers/pipe-server-handlers.ts", import.meta.url);
const DOC = new URL("../docs/pipe-server-grep-example.md", import.meta.url);

async function advertisedExample(): Promise<{ source: string; expr: string }> {
  const source = await readFile(HANDLER, "utf8");
  const expr = source.match(/Example: `([^`]+)`/)?.[1];
  if (!expr) {
    throw new Error("Missing advertised example in pipe-server-handlers.ts");
  }
  return { source, expr };
}

async function guideExpression(): Promise<string> {
  const guide = await readFile(
    new URL("../docs/ashlr-pipe.md", import.meta.url),
    "utf8",
  );
  const section = guide
    .split("### Return grep output from a working directory\n")[1]
    ?.split("\n### ")[0];
  const request = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!request) throw new Error("Missing JSON example in ashlr-pipe.md");
  return (JSON.parse(request) as { expr: string }).expr;
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
    await run(async (expr, fixture) => {
      output = fixture;
      return ashlrPipe(
        { expr },
        { sessionId: "pipe-server-grep-example", env: {} },
      );
    }, calls);
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("the advertised ctx.grep example names the TODO pattern", async () => {
  const { source, expr } = await advertisedExample();
  // The description's example is a single ctx.grep call for pattern 'TODO'.
  expect(expr).toMatch(/\bctx\.grep\(\s*\{\s*pattern\s*:\s*(['"])TODO\1/);
  expect(expr).toContain("return await");
  // The description promises the grep tool's text output as a string.
  expect(source).toContain(
    "returns the grep tool's text output as a string, which may include status messages",
  );
});

test("the advertised example calls grep with TODO and returns its text", async () => {
  const [{ expr }, guideExpr] = await Promise.all([
    advertisedExample(),
    guideExpression(),
  ]);
  // The handler description and the guide document the same call — only the
  // whitespace inside the args object differs.
  expect(expr.replace(/\s+/g, "")).toBe(guideExpr.replace(/\s+/g, ""));

  const grepText =
    "my project/src/app.ts:3:TODO fix this\nmy project/src/config.ts:8:TODO load defaults\n";
  await withGrepFixture(async (evaluate, calls) => {
    const result = await evaluate(expr, grepText);
    // The pipe serializes the returned string as JSON inside text content.
    expect(result.text).toBe(JSON.stringify(grepText));
    expect(JSON.parse(result.text)).toBe(grepText);
    expect(typeof JSON.parse(result.text)).toBe("string");

    // Inside the expression the documented return type really is a string.
    const inner = await evaluate(
      "return typeof (await ctx.grep({pattern:'TODO',cwd:'my project'}));",
      grepText,
    );
    expect(JSON.parse(inner.text)).toBe("string");

    expect(calls).toEqual([
      { pattern: "TODO", cwd: "my project" },
      { pattern: "TODO", cwd: "my project" },
    ]);
  });
});

test("the advertised example returns status and empty-result text unchanged", async () => {
  const { expr } = await advertisedExample();
  await withGrepFixture(async (evaluate, calls) => {
    const shapes = [
      "src/app.ts:3:TODO fix this\n",
      "[no matches]\n",
      "[ashlr confidence: low · bypassSummary:true to recover fidelity]\nsrc/a.ts:1:TODO\n",
      "status: search unavailable\n",
      "",
    ];
    for (const text of shapes) {
      const result = await evaluate(expr, text);
      expect(JSON.parse(result.text)).toBe(text);
    }
    expect(calls).toEqual(
      Array(shapes.length).fill({ pattern: "TODO", cwd: "my project" }),
    );
  });
});

test("the pipe-server grep example doc reproduces the call and its response", async () => {
  const [{ expr }, doc] = await Promise.all([
    advertisedExample(),
    readFile(DOC, "utf8"),
  ]);
  expect(doc).toContain("The pattern is `TODO`");
  expect(doc).toContain("`ctx.grep` returns the grep tool's text as one string");
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)];
  expect(blocks).toHaveLength(2);
  expect((JSON.parse(blocks[0][1]) as { expr: string }).expr).toBe(expr);

  // The doc's illustrated response is the JSON encoding of its grep text.
  const illustrated = JSON.parse(blocks[1][1]) as string;
  expect(illustrated).toBe("src/app.ts:3:TODO fix this\n");
  await withGrepFixture(async (evaluate, calls) => {
    const result = await evaluate(expr, illustrated);
    expect(result.text).toBe(blocks[1][1]);
    expect(JSON.parse(result.text)).toBe(illustrated);
    expect(calls).toEqual([{ pattern: "TODO", cwd: "my project" }]);
  });
});
