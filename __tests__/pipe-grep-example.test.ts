import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { __restoreRegistryForTests, __snapshotRegistryForTests, registerTool } from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

async function documentedExpression(heading: string): Promise<string> {
  const guide = await readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8");
  const section = guide.split(`### ${heading}\n`)[1]?.split("\n### ")[0];
  const request = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!request) throw new Error(`Missing JSON example: ${heading}`);
  return (JSON.parse(request) as { expr: string }).expr;
}

async function withGrepFixture(run: (evaluate: (expr: string, output: string) => Promise<unknown>) => Promise<void>) {
  const registry = __snapshotRegistryForTests();
  let output = "";
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep", description: "fixture", inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: output }] };
      },
    });
    await run(async (expr, fixture) => {
      output = fixture;
      const result = await ashlrPipe({ expr }, { sessionId: "pipe-grep-example", env: {} });
      expect(calls.pop()).toEqual({ pattern: "TODO", cwd: ".", bypassSummary: true });
      return JSON.parse(result.text);
    });
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("documented grep examples extract file and line from representative output", async () => {
  const first = await documentedExpression("Example 1 — grep for TODOs, return file:line pairs");
  const checked = await documentedExpression("Example 2 — grep for TODOs with an empty-result check");
  const matches = "/project/src/app.ts:42:// TODO: validate input\n\n/project/src/config.ts:7:// TODO: load defaults\n";
  const expected = ["/project/src/app.ts:42", "/project/src/config.ts:7"];

  await withGrepFixture(async (evaluate) => {
    expect(await evaluate(first, matches)).toEqual(expected);
    expect(await evaluate(checked, matches)).toEqual(expected);
    const badge = "[ashlr confidence: low · bypassSummary:true to recover fidelity]";
    expect(await evaluate(first, `${matches}${badge}\n`)).toEqual([...expected, "[ashlr confidence: low · bypassSummary"]);
    expect(await evaluate(checked, `${matches}${badge}\n`)).toEqual(expected);
    expect(await evaluate(checked, "src/my project/app.ts:3:TODO: fix\n")).toEqual(["src/my project/app.ts:3"]);
    for (const empty of ["", "[no matches]\n", `${badge}\n`]) {
      expect(await evaluate(checked, empty)).toEqual([]);
    }
  });
});

test("documented grep examples retain order and cap results at 20", async () => {
  const expressions = await Promise.all([
    documentedExpression("Example 1 — grep for TODOs, return file:line pairs"),
    documentedExpression("Example 2 — grep for TODOs with an empty-result check"),
  ]);
  const lines = Array.from({ length: 22 }, (_, i) => `src/file-${i}.ts:${i + 1}:TODO: item`);
  const expected = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts:${i + 1}`);
  await withGrepFixture(async (evaluate) => {
    for (const expr of expressions) {
      expect(await evaluate(expr, lines.join("\n") + "\n")).toEqual(expected);
    }
  });
});

test("walkthrough request and illustrated result agree with the pipe guide", async () => {
  const doc = await readFile(new URL("../docs/pipe-grep-example-walkthrough.md", import.meta.url), "utf8");
  const blocks = [...doc.matchAll(/```(json|text)\n([\s\S]*?)\n```/g)];
  expect(blocks.map((block) => block[1])).toEqual(["json", "text", "json"]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  expect(expr).toBe(await documentedExpression("Example 1 — grep for TODOs, return file:line pairs"));
  const expected = JSON.parse(blocks[2][2]);
  expect(expected).toEqual(["/project/src/app.ts:42", "/project/src/config.ts:7"]);
  await withGrepFixture(async (evaluate) => {
    expect(await evaluate(expr, `${blocks[1][2]}\n`)).toEqual(expected);
    expect(await evaluate(expr, "\nno colon\n")).toEqual([]);
  });
});

test("output guide examples follow the advertised string result and line filter", async () => {
  const doc = await readFile(new URL("../docs/pipe-grep-example-output.md", import.meta.url), "utf8");
  const blocks = [...doc.matchAll(/```(json|text)\n([\s\S]*?)\n```/g)];
  expect(blocks.map((block) => block[1])).toEqual(["json", "text", "json"]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  expect(expr).toBe(await documentedExpression("Example 1 — grep for TODOs, return file:line pairs"));
  const expected = JSON.parse(blocks[2][2]);

  await withGrepFixture(async (evaluate) => {
    expect(await evaluate(expr, `${blocks[1][2]}\n`)).toEqual(expected);
    expect(await evaluate(expr, "")).toEqual([]);
    expect(await evaluate(expr, "[no matches]\n")).toEqual([]);
    expect(await evaluate(expr, "status: unavailable\n")).toEqual(["status: unavailable"]);
  });
});
