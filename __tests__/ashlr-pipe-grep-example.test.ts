/**
 * ashlr-pipe-grep-example.test.ts — guards the ctx.grep examples in
 * docs/ashlr-pipe.md. Every fenced ```json block must parse as JSON, and
 * every request whose expr calls ctx.grep must pass it an args literal
 * containing a nonempty `pattern` string and a `cwd` working-directory
 * argument — the call shape ashlr__grep's inputSchema supports and the
 * ashlr__pipe tool description advertises.
 *
 * Static checks read the args literal out of each expression's source; a
 * behavioral pass then runs every documented grep expression through
 * ashlrPipe with a stubbed ashlr__grep and inspects the forwarded args.
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
const CANONICAL_HEADING = "Return grep output from a working directory";

/** Every fenced ```json block body in the guide, parsed. */
async function jsonBlocks(): Promise<unknown[]> {
  const guide = await readFile(GUIDE, "utf8");
  return [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((block) =>
    JSON.parse(block[1]) as unknown,
  );
}

/** Parsed request bodies whose expr calls ctx.grep. */
async function grepExprs(): Promise<string[]> {
  return (await jsonBlocks())
    .map((body) => (body as { expr?: unknown }).expr)
    .filter(
      (expr): expr is string =>
        typeof expr === "string" && expr.includes("ctx.grep("),
    );
}

/**
 * The source text of the `{...}` args literal in the first `ctx.grep({...})`
 * call of `expr` — quote- and escape-aware so braces inside string literals
 * do not unbalance the match.
 */
function grepArgsLiteral(expr: string): string {
  const call = expr.indexOf("ctx.grep(");
  if (call === -1) throw new Error("expr does not call ctx.grep");
  const start = expr.indexOf("{", call);
  if (start === -1) throw new Error("ctx.grep call has no args object");
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return expr.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in ctx.grep args literal");
}

/** The value of `name: "<literal>"` in an args literal, if present. */
function stringArg(args: string, name: string): string | undefined {
  const match = args.match(
    new RegExp(`\\b${name}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`),
  );
  return match?.slice(1).find((group) => group !== undefined);
}

/** Assert the args literal names a nonempty pattern and a cwd. */
function expectGrepArgs(args: string, context: string): void {
  const pattern = stringArg(args, "pattern");
  expect(pattern, `${context}: ctx.grep must name a pattern`).toBeDefined();
  expect(
    pattern!.length,
    `${context}: ctx.grep pattern must be nonempty`,
  ).toBeGreaterThan(0);
  const cwd = stringArg(args, "cwd");
  expect(cwd, `${context}: ctx.grep must name a cwd`).toBeDefined();
  expect(
    cwd!.length,
    `${context}: ctx.grep cwd must be a nonempty string`,
  ).toBeGreaterThan(0);
}

test("the canonical grep example parses as JSON and names a nonempty pattern and cwd", async () => {
  const guide = await readFile(GUIDE, "utf8");
  const section = guide
    .split(`### ${CANONICAL_HEADING}\n`)[1]
    ?.split("\n### ")[0];
  expect(section, `missing section: ${CANONICAL_HEADING}`).toBeDefined();
  const block = section!.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(block, `missing JSON example: ${CANONICAL_HEADING}`).toBeDefined();

  const request = JSON.parse(block!) as { expr?: unknown };
  expect(typeof request.expr).toBe("string");
  expect(request.expr as string).toContain("ctx.grep(");
  expectGrepArgs(grepArgsLiteral(request.expr as string), CANONICAL_HEADING);
});

test("every ctx.grep example in the guide parses as JSON and names a nonempty pattern and cwd", async () => {
  const exprs = await grepExprs();
  expect(exprs.length).toBeGreaterThan(0);
  for (const expr of exprs) {
    expectGrepArgs(grepArgsLiteral(expr), expr.slice(0, 60));
  }
});

test("documented grep expressions forward a nonempty pattern and cwd to ashlr__grep", async () => {
  const exprs = await grepExprs();
  expect(exprs.length).toBeGreaterThan(0);

  const snapshot = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  try {
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "" }] };
      },
    });
    for (const expr of exprs) {
      await ashlrPipe(
        { expr },
        { sessionId: "ashlr-pipe-grep-example", env: {} },
      );
    }
  } finally {
    __restoreRegistryForTests(snapshot);
  }

  expect(calls).toHaveLength(exprs.length);
  for (const call of calls) {
    expect(typeof call.pattern).toBe("string");
    expect((call.pattern as string).length).toBeGreaterThan(0);
    expect(typeof call.cwd).toBe("string");
    expect((call.cwd as string).length).toBeGreaterThan(0);
  }
});
