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
