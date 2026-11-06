import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GREP_PATTERNS } from "../scripts/run-benchmark.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const doc = () => read("../docs/benchmark-rust-interpretation.md");

describe("docs/benchmark-rust-interpretation.md", () => {
  test("lists every workload pattern in the JSON block, in order", () => {
    const block = doc().match(/```json\n([^]*?)\n```/);
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1]!)).toEqual([...GREP_PATTERNS]);
  });

  test("table identifies the affected patterns and Rust equivalents", () => {
    const text = doc();
    const rows: [string, string][] = [
      ["function ", "fn"],
      ["import ", "use"],
      ["class ", "struct"],
      ["interface ", "trait"],
    ];
    for (const [pattern, rust] of rows) {
      const row = text.split("\n").find((l) => l.startsWith(`| \`${pattern}\``));
      expect(row).toBeDefined();
      expect(row).toContain(`\`${rust}`);
      expect(row).toContain("Low match rate");
    }
    expect(text).toMatch(/\| `TODO` \|[^\n]*not affected by syntax/i);
  });

  test("quoted Rust grep savings match the saved benchmark data", () => {
    const data = JSON.parse(read("../docs/benchmarks-v2.json"));
    const text = doc();
    for (const [key, label] of [["rust-project", "12.2"], ["node-sdk", "30.4"], ["python-lib", "39.1"]]) {
      const ratio = data.byRepo[key].perTool.grep.mean as number;
      expect(((1 - ratio) * 100).toFixed(1)).toBe(label);
    }
    expect(text).toContain("about **−12.2%**");
    expect(text).toContain("−30.4% for\n`node-sdk` and −39.1% for `python-lib`");
  });

  test("is linked from benchmarks.md", () => {
    expect(read("../docs/benchmarks.md")).toContain("(benchmark-rust-interpretation.md)");
  });
});
