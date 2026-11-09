import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function compareMethodology(docs: unknown, published: unknown): string | null {
  for (const [path, value] of [
    ["docs/benchmarks-v2.json", docs],
    ["site/public/benchmarks-v2.json", published],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${path}: methodology must be a non-empty string`);
    }
  }

  const docsLines = (docs as string).split("\n");
  const publicLines = (published as string).split("\n");
  const line = Array.from({ length: Math.max(docsLines.length, publicLines.length) })
    .findIndex((_, index) => docsLines[index] !== publicLines[index]);
  if (line === -1) return null;

  const display = (value: string | undefined) => value === undefined ? "<end of text>" : JSON.stringify(value);
  return `Methodology mismatch at line ${line + 1}:\n` +
    `docs/benchmarks-v2.json: ${display(docsLines[line])}\n` +
    `site/public/benchmarks-v2.json: ${display(publicLines[line])}`;
}

test("saved benchmark methodology text matches exactly", () => {
  const readMethodology = (path: string): unknown =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).methodology;
  const mismatch = compareMethodology(
    readMethodology("../docs/benchmarks-v2.json"),
    readMethodology("../site/public/benchmarks-v2.json"),
  );
  expect(mismatch, mismatch ?? undefined).toBeNull();
});

test("detects changes to either the grep method or other methodology text", () => {
  const docs = JSON.parse(readFileSync(new URL("../docs/benchmarks-v2.json", import.meta.url), "utf8")).methodology as string;
  expect(compareMethodology(docs, docs + " unexpected change")).not.toBeNull();
  const changed = docs.replace("4 000", "5 000");
  expect(changed).not.toBe(docs);
  expect(compareMethodology(docs, changed)).not.toBeNull();
});

test("compares exact text and reports the first differing line", () => {
  expect(compareMethodology("same\ntext", "same\ntext")).toBeNull();
  expect(compareMethodology("same\ndocs", "same\npublic")).toBe(
    'Methodology mismatch at line 2:\n' +
    'docs/benchmarks-v2.json: "docs"\n' +
    'site/public/benchmarks-v2.json: "public"',
  );
  expect(compareMethodology("same\n", "same")).toContain("site/public/benchmarks-v2.json: <end of text>");
  expect(compareMethodology("same", "same\n")).toContain("docs/benchmarks-v2.json: <end of text>");
});

test("rejects missing or empty methodology fields on either side", () => {
  for (const invalid of [undefined, null, 42, "", " \n"]) {
    expect(() => compareMethodology(invalid, "valid"))
      .toThrow("docs/benchmarks-v2.json: methodology must be a non-empty string");
    expect(() => compareMethodology("valid", invalid))
      .toThrow("site/public/benchmarks-v2.json: methodology must be a non-empty string");
  }
});
