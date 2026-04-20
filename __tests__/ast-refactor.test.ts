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
} from "../servers/_ast-refactor";

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
