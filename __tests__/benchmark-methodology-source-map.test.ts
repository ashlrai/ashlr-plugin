import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const files = ["docs/benchmarks-v2.json", "site/public/benchmarks-v2.json"] as const;
const map = read("docs/benchmark-methodology-source-map.md");

describe("benchmark methodology source map", () => {
  test("identifies the snapshots and their recorded dates and commits", () => {
    for (const file of files) {
      const data = JSON.parse(read(file));
      expect(typeof data.methodology).toBe("string");
      expect(data.methodology.length).toBeGreaterThan(0);
      expect(map).toContain(file);
      expect(map).toContain(data.measuredAt);
      expect(map).toContain(data.repo.commit);
    }
    expect(map).toContain("$.methodology");
  });

  test("reports matching decoded methodology strings and their grep method", () => {
    const [docs, publicData] = files.map((file) => JSON.parse(read(file)).methodology as string);
    expect(docs).toBe(publicData);
    expect(map).toContain("The methodology strings match exactly.");
    expect(docs).toContain("plain `rg -n`");
    expect(docs).toContain("300 columns");
    expect(docs).toContain("whole\nlines from the head and tail");
  });
});
