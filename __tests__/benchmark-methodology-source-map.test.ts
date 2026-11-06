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

  test("reports the exact difference between decoded methodology strings", () => {
    const [docs, publicData] = files.map((file) => JSON.parse(read(file)).methodology as string);
    expect(docs).not.toBe(publicData);
    expect(map).toContain("The methodology strings do not match exactly.");

    const paragraph = /\*\*ashlr__grep\*\*:[\s\S]*?(?=\n\n)/;
    const docsGrep = docs.match(paragraph)?.[0];
    const publicGrep = publicData.match(paragraph)?.[0];
    expect(docsGrep).toContain("plain `rg -n`");
    expect(docsGrep).toContain("300 columns");
    expect(docsGrep).toContain("whole\nlines from the head and tail");
    expect(publicGrep).toContain("rg --json");
    expect(publicGrep).toContain("head 2 000 + tail 1 000");
    expect(docs.replace(paragraph, "")).toBe(publicData.replace(paragraph, ""));
  });
});
