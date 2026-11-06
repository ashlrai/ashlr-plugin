import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function benchmarksDoc(): string {
  return readFileSync(new URL("../docs/benchmarks.md", import.meta.url), "utf8");
}

function rustGrepCaveat(docs: string): string {
  const caveat = docs.match(/\*\*Note on grep for Rust:\*\*([^]*?)(?=\n\s*\n|$)/);
  expect(caveat).not.toBeNull();
  return caveat![1]!;
}

function expectRustImportForm(docs: string): void {
  const text = rustGrepCaveat(docs);

  // `use` must be identified as Rust's import form: paired with the `import`
  // workload pattern in the same sentence, with `use` named first — not just
  // mentioned somewhere in the paragraph.
  const pairing = text.match(/[^.]*`use`[^.]*`import`[^.]*\./);
  expect(pairing).not.toBeNull();
  expect(pairing![0]).toMatch(/Rust uses `use` rather than `import`/);
  expect(pairing![0]).toContain("`fn`");
  expect(pairing![0]).toMatch(/struct.*enum.*trait/);

  // The illustrative rg example must likewise label `use ` a Rust import
  // construct, while staying marked as illustrative rather than measured.
  const example = text.match(/`rg -n 'use ' [^`]+` searches for a common Rust import\s+construct/);
  expect(example).not.toBeNull();
  const sentence = text.match(/[^.]*`rg -n 'use ' [^`]+`[^.]*\./);
  expect(sentence![0]).toContain("illustrative alternative");
  expect(sentence![0]).toContain("not a measured pattern");
}

describe("benchmarks.md Rust grep caveat", () => {
  test("identifies `use` as the Rust import form", () => {
    expectRustImportForm(benchmarksDoc());
  });

  test("appears exactly once in the document", () => {
    const docs = benchmarksDoc();
    expect(docs.match(/\*\*Note on grep for Rust:\*\*/g)).toHaveLength(1);
  });

  test("rejects a caveat that no longer pairs `use` with `import`", () => {
    const docs = benchmarksDoc();
    const mutations: [string, string][] = [
      // The pairing is reversed: `import` is no longer the foreign keyword.
      ["`use` rather than `import`", "`import` rather than `use`"],
      // Both words remain but nothing identifies `use` as the Rust form.
      ["Rust uses `use` rather than `import`", "`use` and `import`"],
      // The example still searches `use ` but stops calling it an import
      // construct.
      ["common Rust import\nconstruct", "common Rust search\nconstruct"],
      // The illustrative `use ` example is removed entirely.
      [
        "`rg -n 'use ' bench/refs/rust-project` searches for a common Rust import\nconstruct",
        "a Rust-oriented search",
      ],
      // The whole caveat is dropped.
      ["**Note on grep for Rust:**", "**Note on grep:**"],
    ];
    for (const [from, to] of mutations) {
      const changed = docs.replace(from, to);
      expect(changed).not.toBe(docs);
      expect(() => expectRustImportForm(changed)).toThrow();
    }
  });
});
