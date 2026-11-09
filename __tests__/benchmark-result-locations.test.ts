import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const guide = read("docs/benchmark-result-locations.md");
const files = [
  ["docs/benchmarks-v2.json", "benchmarks-v2.json"],
  ["site/public/benchmarks-v2.json", "../site/public/benchmarks-v2.json"],
] as const;

describe("benchmark result locations", () => {
  test("links each snapshot and records its provenance", () => {
    for (const [path, link] of files) {
      const data = JSON.parse(read(path));
      expect(guide).toContain("[`" + path + "`](" + link + ")");
      expect(readFileSync(new URL(`../docs/${link}`, import.meta.url), "utf8")).toBe(read(path));
      expect(guide).toContain(data.measuredAt);
      expect(guide).toContain(data.repo.commit);
      expect(data.samples.ashlr__read).toHaveLength(16);
      expect(data.methodology).toContain("read\nhas 15");
    }
    expect(guide).toContain("`$.methodology`");
    expect(read("docs/README.md")).toContain("(benchmark-result-locations.md)");
  });

  test("describes the recorded grep method and cross-language date", () => {
    const docs = JSON.parse(read(files[0][0]));
    const publicData = JSON.parse(read(files[1][0]));
    expect(docs.methodology).toContain("plain `rg -n`");
    expect(docs.methodology).toContain("300 columns");
    expect(publicData.methodology).toContain("plain `rg -n`");
    expect(publicData.methodology).toContain("300 columns");
    for (const text of ["`rg -n`", "300-column", docs.crossLanguageMeasuredAt]) {
      expect(guide).toContain(text);
    }
    const page = read("site/app/benchmarks/page.tsx");
    expect(page).toContain('"docs/benchmarks-v2.json"');
    expect(page).toContain('href="/benchmarks-v2.json"');
  });
});
