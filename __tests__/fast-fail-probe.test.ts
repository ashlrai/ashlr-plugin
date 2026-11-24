import { expect, test } from "bun:test";

test("deliberate CI fast-fail probe", () => {
  const block = Array.from({ length: 4000 }, (_, i) => `snapshot-line-${i}`).join("\n");
  expect(block).toBe("different");
});
