import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const doc = read("docs/benchmarks.md");
const script = read("scripts/bench-orchestrate.ts");

describe("benchmarks.md real-LLM limitation matches bench-orchestrate.ts", () => {
  test("documents the stub-only contract and the real-LLM refusal", () => {
    // The script throws when the real-LLM flag is set — the doc must say so.
    expect(script).toContain('process.env["ASHLR_ORCHESTRATE_REAL_LLM"] === "1"');
    expect(script).toContain("refuses to run");
    expect(doc).toContain("scripts/bench-orchestrate.ts");
    expect(doc).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(doc).toMatch(/stub-only/);
    expect(doc).toMatch(/refuses to run/);
  });

  test("documents the same API-call floor the script warns about", () => {
    // Script: "any API call is >100ms" — extract the threshold so the doc
    // cannot drift from the number the bench prints.
    const threshold = script.match(/any API call is ?>\s*(\d+)\s*ms/)?.[1];
    expect(threshold).toBeDefined();
    expect(doc).toContain(`>${threshold}ms`);
    // Script: "the orchestrator overhead measured here only matters as a
    // FLOOR" — the doc must frame the numbers the same way.
    expect(script).toMatch(/only matters as a FLOOR/);
    expect(doc).toMatch(/floor/i);
    // Script: "value of orchestration emerges only when each node's work is
    // non-trivial".
    expect(doc).toMatch(/non-trivial/);
  });

  test("documents the same DAG shapes the bench runs", () => {
    // The SHAPES array literal ends with a `];` at column 0 — later `];`
    // inside builders (e.g. chain-10's `ids` array) are indented.
    const start = script.indexOf("const SHAPES");
    const block = script.slice(start, script.indexOf("\n];", start));
    const names = [...block.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["chain-3", "chain-10", "wide-3", "wide-10", "diamond"]);
    for (const name of names) {
      expect(doc).toContain(name);
    }
  });
});
