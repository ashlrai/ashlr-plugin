import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// These snapshots record different runs. Keep their one known difference exact
// so that changes elsewhere, or undocumented changes to the grep method, fail.
const docsGrep = `**ashlr__grep**: Five common patterns (function, import, TODO, class, interface)
are run via plain \`rg -n\` (path:line:text, the shape a native grep returns)
against the repo root; that output is the raw size. The ashlr__grep fallback
path (no genome) caps lines at 300 columns and, above 4 000 chars, keeps whole
lines from the head and tail. The ratio is ashlr/raw.`;
const publicGrep = `**ashlr__grep**: Five common patterns (function, import, TODO, class, interface)
are run via rg --json against the repo root. Raw output bytes are measured
directly. The ashlr__grep fallback path (no genome) truncates output to 4 000
chars (head 2 000 + tail 1 000). The ratio is truncated/raw.`;

function expectConsistentMethodology(docs: string, published: string): void {
  expect(docs).toContain(docsGrep);
  expect(published).toContain(publicGrep);
  expect(docs.replace(docsGrep, publicGrep)).toBe(published);
}

test("benchmark methodology fields differ only in their recorded grep methods", () => {
  const readMethodology = (path: string): string =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).methodology;
  const docs = readMethodology("../docs/benchmarks-v2.json");
  const published = readMethodology("../site/public/benchmarks-v2.json");

  expectConsistentMethodology(docs, published);
  expect(() => expectConsistentMethodology(docs, published + " unexpected change")).toThrow();
  expect(() => expectConsistentMethodology(docs, published.replace("4 000", "5 000"))).toThrow();
});

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

test("reports the mismatch between the saved benchmark methodologies", () => {
  const readMethodology = (path: string): unknown =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).methodology;
  const mismatch = compareMethodology(
    readMethodology("../docs/benchmarks-v2.json"),
    readMethodology("../site/public/benchmarks-v2.json"),
  );

  expect(mismatch).toContain("Methodology mismatch at line");
  expect(mismatch).toContain("docs/benchmarks-v2.json: \"are run via plain `rg -n`");
  expect(mismatch).toContain("site/public/benchmarks-v2.json: \"are run via rg --json");
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
