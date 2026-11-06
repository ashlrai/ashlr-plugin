/**
 * pipe-server-grep-empty.test.ts — verifies that `ctx.grep` inside an
 * ashlr__pipe expression returns an empty string when no matches exist.
 *
 * The pipe concatenates the grep tool's text content parts verbatim, so an
 * empty tool response surfaces inside the expression as "". docs/
 * pipe-grep-return.md lists "" as one of the no-match shapes alongside the
 * "[no matches]" sentinel, so the distinction matters: expressions that
 * check `output === ""` and ones that check for the sentinel are both
 * supported, and this file pins the empty-string contract.
 */

import { expect, test } from "bun:test";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
  type ToolCallContext,
  type ToolTextContent,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

const ctx: ToolCallContext = { sessionId: "pipe-server-grep-empty", env: {} };

async function withGrepContent(
  content: ToolTextContent[],
  run: (calls: Record<string, unknown>[]) => Promise<void>,
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
        return { content };
      },
    });
    await run(calls);
  } finally {
    __restoreRegistryForTests(registry);
  }
}

test("ctx.grep returns an empty string when no matches exist", async () => {
  await withGrepContent([{ type: "text", text: "" }], async (calls) => {
    const args = { pattern: "absent-needle", cwd: ".", bypassSummary: true };

    const result = await ashlrPipe(
      { expr: "return await ctx.grep({ pattern: 'absent-needle', cwd: '.', bypassSummary: true });" },
      ctx,
    );
    // The empty tool response concatenates to "" and serializes as a JSON
    // string — not null, not the "[no matches]" sentinel.
    expect(result.text).toBe('""');
    expect(JSON.parse(result.text)).toBe("");
    // An empty intermediate result contributes zero bytes, so the pipe
    // records no aggregate saving for it.
    expect(result.rawIntermediate).toBe(0);

    // Inside the expression the value really is an empty string.
    const inner = await ashlrPipe(
      {
        expr:
          "const out = await ctx.grep({ pattern: 'absent-needle', cwd: '.', bypassSummary: true });" +
          " return [typeof out, out.length, out === ''];",
      },
      ctx,
    );
    expect(JSON.parse(inner.text)).toEqual(["string", 0, true]);

    expect(calls).toEqual([args, args]);
  });
});

test("ctx.grep returns an empty string when grep emits no content parts", async () => {
  await withGrepContent([], async (calls) => {
    const result = await ashlrPipe(
      { expr: "return await ctx.grep({ pattern: 'absent-needle' });" },
      ctx,
    );
    // Zero content parts join to the same empty string.
    expect(result.text).toBe('""');
    expect(JSON.parse(result.text)).toBe("");
    expect(result.rawIntermediate).toBe(0);
    expect(calls).toEqual([{ pattern: "absent-needle" }]);
  });
});
