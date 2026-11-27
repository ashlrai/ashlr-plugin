import { expect, test } from "bun:test";
import {
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  registerTool,
} from "../servers/_tool-base";
import { ashlrPipe } from "../servers/pipe-server";

// New pipe-server cases live in their own file (see AGENTS.md "Hot files").

test("ctx.grep keeps multiline results in match order, line breaks intact", async () => {
  const registry = __snapshotRegistryForTests();
  try {
    // Two content parts, deliberately not in alphabetical order.
    const parts = ["z.ts:3:needle zebra\nz.ts:9:needle yak\n", "a.ts:1:needle ant\na.ts:2:needle bee\n"];
    registerTool({
      name: "ashlr__grep",
      description: "fixture",
      inputSchema: {},
      handler: async () => ({ content: parts.map((text) => ({ type: "text" as const, text })) }),
    });
    const result = await ashlrPipe(
      { expr: `const out = await ctx.grep({ pattern: "needle" }); return { out, lines: out.split("\\n") };` },
      { sessionId: "grep-multiline", env: {} },
    );
    const value = JSON.parse(result.text);
    expect(value.out).toBe(parts.join(""));
    expect(value.lines).toEqual([
      "z.ts:3:needle zebra",
      "z.ts:9:needle yak",
      "a.ts:1:needle ant",
      "a.ts:2:needle bee",
      "",
    ]);
  } finally {
    __restoreRegistryForTests(registry);
  }
});
