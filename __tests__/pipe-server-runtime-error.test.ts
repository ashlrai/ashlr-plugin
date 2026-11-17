import { expect, test } from "bun:test";
import { getTool } from "../servers/_tool-base";

test("a thrown expression reports an error and the next expression succeeds", async () => {
  process.env.ASHLR_PIPE_ENABLE = "1";
  await import("../servers/pipe-server-handlers");
  const tool = getTool("ashlr__pipe");
  if (!tool) throw new Error("pipe handler was not registered");
  const ctx = { sessionId: "pipe-runtime-error", env: {} };
  const failed = await tool.handler({ expr: 'throw new Error("fixture failure");' }, ctx);
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toContain("fixture failure");
  const next = await tool.handler({ expr: "return 42;" }, ctx);
  expect(next.isError).not.toBe(true);
  expect(next.content).toEqual([{ type: "text", text: "42" }]);
});
