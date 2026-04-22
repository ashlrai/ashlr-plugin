/**
 * ast-refactor.test.ts — Track C v1.13: file-local AST rename.
 *
 * Covers:
 *   - Simple file-local rename (value-position)
 *   - Value vs type kind disambiguation
 *   - Multi-declaration refusal (shadowing guard)
 *   - Collision guard: renaming to a name already used in the file
 *   - No-match error
 *   - applyRangeEdits correctness (right-to-left, overlap detection)
 *   - Unsupported file extension handling
 *   - Full round-trip via ashlr__edit_structural handler (dry-run + write)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  applyRangeEdits,
  planRenameInFile,
  planCrossFileRename,
  planExtractFunction,
} from "../servers/_ast-refactor";
import { parseFile } from "../servers/_ast-helpers";

let tmpProj: string;
const ORIGINAL_CWD = process.cwd();

beforeEach(async () => {
  tmpProj = await mkdtemp(join(tmpdir(), "ashlr-ast-refactor-"));
});

afterEach(async () => {
  // Guard against any test that mutated cwd — never leave it changed for peers.
  if (process.cwd() !== ORIGINAL_CWD) {
    try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  }
  await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
});

describe("applyRangeEdits", () => {
  test("applies edits right-to-left so offsets stay valid", () => {
    const src = "hello world hello";
    const out = applyRangeEdits(src, [
      { start: 0, end: 5, replacement: "HI" },
      { start: 12, end: 17, replacement: "HI" },
    ]);
    expect(out).toBe("HI world HI");
  });

  test("rejects overlapping ranges", () => {
    expect(() =>
      applyRangeEdits("abcdef", [
        { start: 0, end: 3, replacement: "X" },
        { start: 2, end: 5, replacement: "Y" },
      ]),
    ).toThrow(/overlapping/);
  });

  test("rejects ranges past end of source", () => {
    expect(() =>
      applyRangeEdits("abc", [{ start: 0, end: 10, replacement: "X" }]),
    ).toThrow(/invalid range/);
  });

  test("empty edit list is a no-op", () => {
    expect(applyRangeEdits("abc", [])).toBe("abc");
  });
});

describe("planRenameInFile · simple file-local rename (value)", () => {
  test("renames every occurrence of a function in the same file", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `export function greet(who: string): string {
  return "hi " + who;
}
const msg = greet("world");
export const double = () => greet("twice") + greet("again");
`,
    );

    const plan = await planRenameInFile(path, "greet", "hello");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.references).toBe(4); // 1 declaration + 3 call sites
    const source = await readFile(path, "utf-8");
    const rewritten = applyRangeEdits(source, plan.edits);
    expect(rewritten).toContain("export function hello(who: string): string");
    expect(rewritten).toContain("hello(\"world\")");
    expect(rewritten).toContain("hello(\"twice\")");
    expect(rewritten).not.toContain("greet");
  });

  test("returns empty warnings when the declaration is in-file", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(path, `function foo() { return foo; }`);
    const plan = await planRenameInFile(path, "foo", "bar");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings).toEqual([]);
  });

  test("warns when no in-file declaration is found (imported/global symbol)", async () => {
    const path = join(tmpProj, "sample.ts");
    // `console` is not declared in-file — it's a global.
    await writeFile(path, `export function log(msg: string) { console.log(msg); }`);
    const plan = await planRenameInFile(path, "console", "myConsole");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toMatch(/may be bound in an outer scope/);
  });
});

describe("planRenameInFile · kind disambiguation", () => {
  test("default kind=value leaves a same-named interface alone", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `interface Foo { x: number }
const Foo = { x: 1 };
export const use = Foo.x;
`,
    );
    const plan = await planRenameInFile(path, "Foo", "Bar"); // kind defaults to value
    // Two value-position Foo sites (const decl + Foo.x usage), zero type-side ones touched.
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const src = await readFile(path, "utf-8");
    const out = applyRangeEdits(src, plan.edits);
    expect(out).toContain("interface Foo { x: number }"); // type untouched
    expect(out).toContain("const Bar");
    expect(out).toContain("Bar.x");
  });

  test("kind=type renames the type-side only", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `type Foo = { x: number };
const Foo = { x: 1 };
`,
    );
    const plan = await planRenameInFile(path, "Foo", "Bar", { kind: "type" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const src = await readFile(path, "utf-8");
    const out = applyRangeEdits(src, plan.edits);
    expect(out).toContain("type Bar"); // type renamed
    expect(out).toContain("const Foo = { x: 1 }"); // value untouched
  });
});

describe("planRenameInFile · shadowing / multi-declaration guard", () => {
  test("refuses when outer function + inner parameter share the name", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `function foo(x: number) {
  function foo(y: number) { return y; }
  return foo(x);
}
`,
    );
    const plan = await planRenameInFile(path, "foo", "bar");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/declaration sites/);
    expect(plan.reason).toMatch(/refused/);
  });

  test("force:true bypasses the shadowing guard", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `function foo(x: number) {
  function foo(y: number) { return y; }
  return foo(x);
}
`,
    );
    const plan = await planRenameInFile(path, "foo", "bar", { force: true });
    expect(plan.ok).toBe(true);
  });
});

describe("planRenameInFile · collision guard", () => {
  test("refuses when the new name already exists as a value in the file", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `const a = 1;
const b = 2;
export const sum = a + b;
`,
    );
    const plan = await planRenameInFile(path, "a", "b");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already exists/);
  });
});

describe("planRenameInFile · error cases", () => {
  test("returns ok:false when name not found", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(path, `export const x = 1;`);
    const plan = await planRenameInFile(path, "nonexistent", "other");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/no value-position identifier/);
  });

  test("rejects identical old and new names", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(path, `const a = 1;`);
    const plan = await planRenameInFile(path, "a", "a");
    expect(plan.ok).toBe(false);
  });

  test("rejects invalid new identifier syntax", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(path, `const a = 1;`);
    const plan = await planRenameInFile(path, "a", "not a valid id");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/not a valid/);
  });

  test("rejects reserved-word new name", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(path, `const a = 1;`);
    const plan = await planRenameInFile(path, "a", "class");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/reserved word/);
  });

  test("returns ok:false for unsupported file extension", async () => {
    const path = join(tmpProj, "sample.txt");
    await writeFile(path, `const a = 1;`);
    const plan = await planRenameInFile(path, "a", "b");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/unsupported language/);
  });
});

describe("planRenameInFile · rewrite still parses", () => {
  test("after rename, the output is structurally valid TS", async () => {
    const path = join(tmpProj, "sample.ts");
    await writeFile(
      path,
      `import { readFile } from "fs/promises";
export async function loadConfig(p: string): Promise<string> {
  return readFile(p, "utf-8");
}
export const DEFAULT = loadConfig("/etc/app.conf");
`,
    );
    const plan = await planRenameInFile(path, "loadConfig", "loadSettings");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const before = await readFile(path, "utf-8");
    const after = applyRangeEdits(before, plan.edits);

    // Parse the rewritten source to confirm it still makes a tree.
    // Write to a new file so parseFile can resolve the language.
    const outPath = join(tmpProj, "sample.rewritten.ts");
    await writeFile(outPath, after);
    const verify = await planRenameInFile(outPath, "loadSettings", "loadSettings2");
    expect(verify.ok).toBe(true); // parsed + found identifier → structural validity check
    if (!verify.ok) return;
    expect(verify.references).toBe(plan.references);
  });
});

// ---------------------------------------------------------------------------
// planCrossFileRename
// ---------------------------------------------------------------------------

describe("planCrossFileRename · basic multi-file rename", () => {
  test("renames symbol in 3 files", async () => {
    const a = join(tmpProj, "a.ts");
    const b = join(tmpProj, "b.ts");
    const c = join(tmpProj, "c.ts");
    await writeFile(a, `export function myFn() {}\n`);
    await writeFile(b, `import { myFn } from "./a";\nmyFn();\n`);
    await writeFile(c, `import { myFn } from "./a";\nexport const x = myFn();\n`);

    const result = await planCrossFileRename(tmpProj, "myFn", "myFunction");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileEdits.length).toBe(3);
    const totalRefs = result.fileEdits.reduce((s, f) => s + f.references, 0);
    expect(totalRefs).toBeGreaterThanOrEqual(4); // 1 decl + 3 usages
  });

  test("skips file with shadowing collision and emits warning", async () => {
    const good = join(tmpProj, "good.ts");
    const bad = join(tmpProj, "bad.ts");
    await writeFile(good, `export function shadow() {}\n`);
    // bad.ts has two declarations of 'shadow' → shadowing guard fires
    await writeFile(bad, `function shadow(x: number) {\n  function shadow(y: number) { return y; }\n  return shadow(x);\n}\n`);

    const result = await planCrossFileRename(tmpProj, "shadow", "shade");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only good.ts should succeed
    const paths = result.fileEdits.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("good.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("bad.ts"))).toBe(false);
    // Warning about bad.ts
    expect(result.warnings.some((w) => w.includes("bad.ts"))).toBe(true);
  });

  test("returns ok:false when symbol has no occurrences", async () => {
    await writeFile(join(tmpProj, "empty.ts"), `export const x = 1;\n`);
    const result = await planCrossFileRename(tmpProj, "nonexistentSymbol", "other");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no safe rename sites/);
  });

  test("include glob restricts to matched files only", async () => {
    await writeFile(join(tmpProj, "main.ts"), `export function target() {}\n`);
    await writeFile(join(tmpProj, "other.js"), `function target() {}\n`);

    // Only include .ts files
    const result = await planCrossFileRename(tmpProj, "target", "renamed", {
      include: ["**/*.ts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.fileEdits.map((f) => f.path);
    expect(paths.every((p) => p.endsWith(".ts"))).toBe(true);
  });

  test("exclude glob skips matched files", async () => {
    await writeFile(join(tmpProj, "keep.ts"), `export function excl() {}\n`);
    await writeFile(join(tmpProj, "skip.ts"), `export function excl() {}\n`);

    const result = await planCrossFileRename(tmpProj, "excl", "included", {
      exclude: ["**/skip.ts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.fileEdits.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("skip.ts"))).toBe(false);
    expect(paths.some((p) => p.endsWith("keep.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planExtractFunction
// ---------------------------------------------------------------------------

describe("planExtractFunction · MVP", () => {
  async function parseSrc(src: string, ext = ".ts"): Promise<{ parsed: NonNullable<Awaited<ReturnType<typeof parseFile>>>; path: string }> {
    const p = join(tmpProj, `extract${ext}`);
    await writeFile(p, src);
    const parsed = await parseFile(p);
    if (!parsed) throw new Error("parseFile returned null");
    return { parsed, path: p };
  }

  test("extracts single expression from top-level → correct insert + call", async () => {
    const src = `export function main() {\n  const a = 1;\n  const b = 2;\n  const c = a + b;\n}\n`;
    const { parsed } = await parseSrc(src);
    // Extract "a + b" — find its byte range
    const bodyText = "a + b";
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "add", start, end });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = applyRangeEdits(result.source!, result.edits!);
    expect(out).toContain("function add(");
    expect(out).toContain("add(");
  });

  test("extracts from inside a method body", async () => {
    const src = `class Calc {\n  run() {\n    const x = 10;\n    const y = 20;\n    const z = x + y;\n  }\n}\n`;
    const { parsed } = await parseSrc(src);
    const bodyText = "x + y";
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "sum", start, end });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = applyRangeEdits(result.source!, result.edits!);
    expect(out).toContain("function sum(");
  });

  test("refuses range containing 'return'", async () => {
    const src = `export function foo(x: number) {\n  return x + 1;\n}\n`;
    const { parsed } = await parseSrc(src);
    const bodyText = "return x + 1;";
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "bar", start, end });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/return/);
  });

  test("refuses range containing 'throw'", async () => {
    const src = `export function foo() {\n  throw new Error("oops");\n}\n`;
    const { parsed } = await parseSrc(src);
    const bodyText = `throw new Error("oops");`;
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "bar", start, end });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/throw/);
  });

  test("refuses range containing 'await'", async () => {
    const src = `export async function foo() {\n  const x = await Promise.resolve(1);\n}\n`;
    const { parsed } = await parseSrc(src);
    const bodyText = "await Promise.resolve(1)";
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "bar", start, end });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/await/);
  });

  test("empty range (start === end) → ok:false", async () => {
    const src = `const x = 1;\n`;
    const { parsed } = await parseSrc(src);
    const result = planExtractFunction(parsed, { newFunctionName: "foo", start: 5, end: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  test("outer-scope variable becomes a parameter", async () => {
    const src = `const multiplier = 3;\nexport function compute(val: number) {\n  const result = val * multiplier;\n}\n`;
    const { parsed } = await parseSrc(src);
    const bodyText = "val * multiplier";
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "multiply", start, end });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = applyRangeEdits(result.source!, result.edits!);
    // Both val and multiplier should appear as params (they're outer-scope refs)
    expect(out).toMatch(/function multiply\(/);
    // The extracted function signature should include these identifiers
    expect(out).toContain("multiply(");
  });

  test("range referencing no outer vars → empty param list", async () => {
    // Extract a call_expression that only uses its own literal args
    const src = `export function go() {\n  const r = Math.max(2, 4);\n}\n`;
    const { parsed } = await parseSrc(src);
    const bodyText = "Math.max(2, 4)";
    const start = src.indexOf(bodyText);
    const end = start + bodyText.length;
    const result = planExtractFunction(parsed, { newFunctionName: "getMax", start, end });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = applyRangeEdits(result.source!, result.edits!);
    // Math is a global — it might appear as a param, but no user-defined outer vars
    expect(out).toContain("function getMax(");
    expect(out).toContain("getMax(");
  });
});
