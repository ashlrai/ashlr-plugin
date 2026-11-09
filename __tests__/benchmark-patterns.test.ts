import { expect, test } from "bun:test";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

test("the benchmark grep workload includes TODO exactly once", () => {
  expect(GREP_PATTERNS.filter((pattern) => pattern === "TODO")).toHaveLength(1);
});
