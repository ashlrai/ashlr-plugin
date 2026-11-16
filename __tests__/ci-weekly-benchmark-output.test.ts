import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// The weekly self-repo benchmark (scripts/run-benchmark.ts) emits a different
// shape from the canonical multi-repo docs/benchmarks-v2.json (written by
// scripts/benchmark-refs.ts). Writing it over the canonical file broke the
// docs-vs-site parity tests on main, so the weekly job must use its own path.
describe("weekly benchmark job output path", () => {
  const ci = readFileSync(join(import.meta.dir, "..", ".github/workflows/ci.yml"), "utf8");
  const start = ci.indexOf("run: bun run scripts/run-benchmark.ts --repo . --out");

  test("runs the self-repo benchmark", () => {
    expect(start).toBeGreaterThan(-1);
  });

  test("does not overwrite the canonical docs/benchmarks-v2.json", () => {
    const job = ci.slice(start, start + 2500);
    expect(job).not.toContain("docs/benchmarks-v2.json");
    expect(job).toContain("docs/benchmarks-self.json");
  });
});
