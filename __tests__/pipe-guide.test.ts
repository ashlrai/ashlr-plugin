/**
 * pipe-guide.test.ts — guards the worked grep examples in docs/ashlr-pipe.md
 * against the contract the guide advertises: an expression that splits the
 * ctx.grep text into lines requests unsummarized output via
 * `bypassSummary: true`, so raw `path:line:text` lines reach the expression
 * instead of an LLM summary (see bypassSummary in servers/grep-server-handlers.ts).
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const GUIDE = new URL("../docs/ashlr-pipe.md", import.meta.url);

async function guideSection(heading: string): Promise<string> {
  const guide = await readFile(GUIDE, "utf8");
  const section = guide.split(`### ${heading}\n`)[1]?.split(/\n#{2,3} /)[0];
  if (!section) throw new Error(`Missing section: ${heading}`);
  return section;
}

async function documentedExpr(heading: string): Promise<string> {
  const block = (await guideSection(heading)).match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error(`Missing JSON example: ${heading}`);
  return (JSON.parse(block) as { expr: string }).expr;
}

async function workedExamples(): Promise<{ heading: string; expr: string }[]> {
  const guide = await readFile(GUIDE, "utf8");
  const worked = guide.split("## Worked examples\n")[1]?.split("\n## ")[0];
  if (!worked) throw new Error("Missing worked examples section");
  const examples: { heading: string; expr: string }[] = [];
  for (const part of worked.split("\n### ")) {
    const block = part.match(/```json\n([\s\S]*?)\n```/)?.[1];
    if (block) {
      examples.push({
        heading: part.split("\n")[0].replace(/^### /, ""),
        expr: (JSON.parse(block) as { expr: string }).expr,
      });
    }
  }
  return examples;
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
      const result = await ashlrPipe({ expr }, { sessionId: "pipe-guide", env: {} });
      return JSON.parse(result.text);
    }, calls);
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("the TODO grep example requests unsummarized output and splits it into lines", async () => {
  const [section, expr] = await Promise.all([
    guideSection("Filter empty grep-result lines"),
    documentedExpr("Filter empty grep-result lines"),
  ]);
  expect(section).toContain("Split the string returned by `ctx.grep` into lines");
  expect(expr).toContain("pattern: 'TODO'");
  expect(expr).toContain("bypassSummary: true");
  expect(expr).toContain(".split('\\n')");

  const output = "src/app.ts:3:TODO first\n\nsrc/config.ts:8:TODO second\n";
  await withGrepFixture(output, async (evaluate, calls) => {
    expect(await evaluate(expr)).toEqual([
      "src/app.ts:3:TODO first",
      "src/config.ts:8:TODO second",
    ]);
    expect(calls).toEqual([{ pattern: "TODO", cwd: ".", bypassSummary: true }]);
  });
});

test("the canonical file:line TODO grep example requests unsummarized output and splits it into lines", async () => {
  const expr = await documentedExpr("Example 1 — grep for TODOs, return file:line pairs");
  expect(expr).toContain("pattern: 'TODO'");
  expect(expr).toContain("bypassSummary: true");
  expect(expr).toContain(".split('\\n')");

  const output =
    "/project/src/app.ts:42:// TODO: validate input\n/project/src/config.ts:7:// TODO: load defaults\n";
  await withGrepFixture(output, async (evaluate, calls) => {
    expect(await evaluate(expr)).toEqual(["/project/src/app.ts:42", "/project/src/config.ts:7"]);
    expect(calls).toEqual([{ pattern: "TODO", cwd: ".", bypassSummary: true }]);
  });
});

test("every worked example that splits grep output into lines requests unsummarized output", async () => {
  const examples = await workedExamples();
  const greps = examples.filter(({ expr }) => /ctx\.grep\(/.test(expr));
  const splitting = greps.filter(({ expr }) => expr.includes(".split('\\n')"));
  // The guide documents several line-splitting grep pipelines; each one must
  // keep bypassSummary: true so the lines it splits are unsummarized rg text,
  // not an LLM summary. Unsplit examples are unconstrained — the fallback
  // example legitimately pairs bypassSummary with output.trim() instead.
  expect(splitting.length).toBeGreaterThan(1);
  for (const { heading, expr } of splitting) {
    expect(expr, `${heading} splits grep output into lines`).toContain("bypassSummary: true");
    expect(expr, `${heading} splits grep output into lines`).toContain("pattern: 'TODO'");
  }
});

test("worked-example expressions parse and stay within the documented 2000-character limit", async () => {
  const examples = await workedExamples();
  expect(examples.length).toBeGreaterThan(0);
  for (const { heading, expr } of examples) {
    expect(typeof expr, heading).toBe("string");
    expect(expr.length, heading).toBeLessThanOrEqual(2000);
  }
});
