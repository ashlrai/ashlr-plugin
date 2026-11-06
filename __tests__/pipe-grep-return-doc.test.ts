import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { __restoreRegistryForTests, __snapshotRegistryForTests, registerTool } from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const DOC = new URL("../docs/pipe-grep-return.md", import.meta.url);

async function docSection(heading: string): Promise<string> {
  const doc = await readFile(DOC, "utf8");
  const section = doc.split(`### ${heading}\n`)[1]?.split(/\n#{2,3} /)[0];
  if (!section) throw new Error(`Missing section: ${heading}`);
  return section;
}

async function docExpr(heading: string): Promise<string> {
  const block = (await docSection(heading)).match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error(`Missing JSON example: ${heading}`);
  return (JSON.parse(block) as { expr: string }).expr;
}

async function withGrepFixture(
  run: (evaluate: (expr: string, output: string) => Promise<unknown>, calls: Record<string, unknown>[]) => Promise<void>,
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
      const result = await ashlrPipe({ expr }, { sessionId: "pipe-grep-return-doc", env: {} });
      return JSON.parse(result.text);
    }, calls);
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("documented empty-array example returns [] for every empty output shape", async () => {
  const section = await docSection("Return an empty array for no matches");
  const blocks = [...section.matchAll(/```(json|text)\n([\s\S]*?)\n```/g)];
  expect(blocks.map((block) => block[1])).toEqual(["json", "text", "json"]);
  const { expr } = JSON.parse(blocks[0][2]) as { expr: string };
  const emptyExpected = JSON.parse(blocks[2][2]);
  expect(emptyExpected).toEqual([]);

  const badge = "[ashlr confidence: low · bypassSummary:true to recover fidelity]";
  await withGrepFixture(async (evaluate, calls) => {
    // The doc's own fixture: sentinel + status line → [].
    expect(await evaluate(expr, `${blocks[1][2]}\n`)).toEqual(emptyExpected);
    for (const empty of ["", " \n", "[no matches]\n", `${badge}\n`, "status: search unavailable\n"]) {
      expect(await evaluate(expr, empty)).toEqual([]);
    }
    const matches = "src/app.ts:3:TODO first\nsrc/config.ts:8:TODO second\n";
    expect(await evaluate(expr, matches)).toEqual(["src/app.ts:3:TODO first", "src/config.ts:8:TODO second"]);
    expect(await evaluate(expr, `${matches}${badge}\n`)).toEqual([
      "src/app.ts:3:TODO first",
      "src/config.ts:8:TODO second",
    ]);
    const many = Array.from({ length: 22 }, (_, i) => `src/file-${i}.ts:${i + 1}:TODO: item`);
    expect(await evaluate(expr, many.join("\n") + "\n")).toEqual(many.slice(0, 20));
    expect(calls).toEqual(Array(9).fill({ pattern: "TODO", cwd: ".", bypassSummary: true }));
  });
});

test("documented fallback example maps bare empty output and preserves annotated output", async () => {
  const expr = await docExpr("Return a fallback message for no matches");
  await withGrepFixture(async (evaluate, calls) => {
    for (const empty of ["", " \n", "[no matches]\n"]) {
      expect(await evaluate(expr, empty)).toBe("No TODOs found");
    }
    for (const kept of ["[no matches]\n[ashlr] status\n", "status: search unavailable\n", "src/a.ts:1:TODO\n"]) {
      expect(await evaluate(expr, kept)).toBe(kept);
    }
    expect(calls).toEqual(Array(6).fill({ pattern: "TODO", cwd: ".", bypassSummary: true }));
  });
});

test("the document explains the grep return type and the empty-result syntax", async () => {
  const doc = await readFile(DOC, "utf8");
  expect(doc).toContain("resolves to a `string`");
  expect(doc).toContain("[no matches]");
  expect(doc).toContain("lines.length === 0");
  expect(doc).toContain("JSON.stringify");
  expect(doc).toContain("ashlr-pipe.md");
});
