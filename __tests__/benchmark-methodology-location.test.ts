import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const guide = read("docs/benchmark-methodology-location.md");

describe("benchmark methodology locations", () => {
  test("documents the top-level string in both snapshots with working links", () => {
    for (const [path, link] of [
      ["docs/benchmarks-v2.json", "benchmarks-v2.json"],
      ["site/public/benchmarks-v2.json", "../site/public/benchmarks-v2.json"],
    ]) {
      const data = JSON.parse(read(path));
      expect(typeof data.methodology).toBe("string");
      expect(data.methodology.length).toBeGreaterThan(0);
      expect(guide).toContain(`[\`${path}\`](${link})`);
      expect(readFileSync(new URL(`../docs/${link}`, import.meta.url), "utf8")).toBe(read(path));
    }
    expect(guide).toContain("`$.methodology`");
    expect(read("docs/README.md")).toContain("(benchmark-methodology-location.md)");
  });

  test("distinguishes the displayed data from the public download", () => {
    const page = read("site/app/benchmarks/page.tsx");
    expect(page).toContain('"docs/benchmarks-v2.json"');
    expect(page).toContain("{data.methodology}");
    expect(page).toContain('href="/benchmarks-v2.json"');
    expect(guide).toContain("reads this file at build time");
    expect(guide).toContain("`/benchmarks-v2.json`");
    expect(guide).toContain("methodology strings currently differ");
    const docs = JSON.parse(read("docs/benchmarks-v2.json"));
    const publicData = JSON.parse(read("site/public/benchmarks-v2.json"));
    expect(docs.methodology).not.toBe(publicData.methodology);
  });
});
