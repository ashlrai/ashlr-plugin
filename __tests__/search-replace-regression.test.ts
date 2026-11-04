/**
 * search-replace-regression.test.ts — literal pattern and replacement
 * edge cases (escaped metacharacters, `$` tokens, repeated matches).
 *
 * `replacement` follows JS String.replace semantics, so `$$` yields one
 * literal `$`, while a `$` that does not start a token (`$ `, `$USD`, a
 * trailing `$`) already passes through unchanged. Each case asserts the
 * exact file bytes, in dry-run (untouched) and apply modes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

let tmpProj: string;
const ORIGINAL_CWD = process.cwd();

beforeEach(async () => {
  tmpProj = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-reg-")));
  process.chdir(tmpProj);
});

afterEach(async () => {
  try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
});

describe("literal dollar sign in replacement", () => {
  test("`$$` before a digit becomes one literal `$` (price rewrite)", async () => {
    const file = join(tmpProj, "price.txt");
    const original = "price: PRICE\n";
    await writeFile(file, original);

    const args = { pattern: "PRICE", replacement: "$$19.99" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("price: $19.99\n");
  });

  test("a `$` that starts no token stays literal, including a trailing `$`", async () => {
    const file = join(tmpProj, "plain.txt");
    await writeFile(file, "a=X\nb=X\n");

    await ashlrSearchReplaceRegex({ pattern: "X", replacement: "$USD $ end$" });
    expect(await readFile(file, "utf-8")).toBe("a=$USD $ end$\nb=$USD $ end$\n");
  });

  test("literal `$` coexists with a real capture reference", async () => {
    const file = join(tmpProj, "mixed.txt");
    await writeFile(file, "cost 5\n");

    await ashlrSearchReplaceRegex({ pattern: "cost (\\d+)", replacement: "$$$1 total" });
    expect(await readFile(file, "utf-8")).toBe("$5 total\n");
  });
});

describe("literal plus sign in pattern", () => {
  test("escaped `\\+` replaces only the exact `a+b`, not `aab` or `ab`", async () => {
    const file = join(tmpProj, "plus.txt");
    const original = "a+b aab ab a++b a+b\n";
    await writeFile(file, original);

    const args = { pattern: "a\\+b", replacement: "SUM" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("SUM aab ab a++b SUM\n");
  });
});

describe("literal pattern with no match", () => {
  test("an absent literal leaves the file unchanged and reports 0 files, 0 replacements", async () => {
    const file = join(tmpProj, "absent.txt");
    const original = "alpha beta\nprice: $5 (a+b)\n";
    await writeFile(file, original);

    // `\+` and `\$` are escaped so the pattern is a plain literal that is not in the file.
    const args = { pattern: "a\\+\\+b\\$", replacement: "SUM" };
    for (const dryRun of [true, false]) {
      const { text } = await ashlrSearchReplaceRegex({ ...args, dryRun });
      expect(text).toContain("0 files, 0 replacements");
      expect(await readFile(file, "utf-8")).toBe(original);
    }
  });

  test("a file without the literal stays byte-identical while a matching sibling is rewritten", async () => {
    const hit = join(tmpProj, "hits.txt");
    const miss = join(tmpProj, "miss.txt");
    // `a+`, `a++`, `a+b`, `aXb` all fall short of the full `a++b` needle, so
    // only the sibling matches and `miss.txt` never enters the plan.
    const missOriginal = Buffer.from("near misses: a+ a++ a+b aXb\r\ncafé\n", "utf-8");
    await writeFile(hit, "a++b and a++b\n");
    await writeFile(miss, missOriginal);

    const args = { pattern: "a\\+\\+b", replacement: "SUM" };

    const dry = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dry.text).toContain("1 file, 2 replacements");
    expect(dry.text).not.toContain("miss.txt");
    expect(await readFile(miss)).toEqual(missOriginal);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(hit, "utf-8")).toBe("SUM and SUM\n");
    expect(await readFile(miss)).toEqual(missOriginal);
  });
});

describe("literal question mark in pattern", () => {
  test("escaped `\\?` replaces only the exact `a?b`, not `ab` or `aab`", async () => {
    const file = join(tmpProj, "question.txt");
    const original = "a?b ab aab a??b a?b\n";
    await writeFile(file, original);

    const args = { pattern: "a\\?b", replacement: "ASK" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("ASK ab aab a??b ASK\n");
  });

  test("unescaped `?` is a quantifier, a `?` in a character class is literal", async () => {
    const file = join(tmpProj, "quantifier.txt");
    await writeFile(file, "a?b ab\n");

    const quantifier = await ashlrSearchReplaceRegex({ pattern: "a?b", replacement: "X", dryRun: true });
    expect(quantifier.text).toContain("1 file, 2 replacements");

    await ashlrSearchReplaceRegex({ pattern: "a[?]b", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT ab\n");
  });
});

describe("literal caret in pattern", () => {
  test("escaped `\\^` replaces only a text caret, not the line start", async () => {
    const file = join(tmpProj, "caret.txt");
    const original = "a^b\n2^8 x^y\nab\n";
    await writeFile(file, original);

    const args = { pattern: "\\^", replacement: "POW" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("aPOWb\n2POW8 xPOWy\nab\n");
  });

  test("a caret inside a character class is a literal, not an anchor", async () => {
    const file = join(tmpProj, "class.txt");
    await writeFile(file, "a^b ab\n");

    await ashlrSearchReplaceRegex({ pattern: "a[\\^]b", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT ab\n");
  });

  test("a caret-containing literal replaces only that exact text", async () => {
    const file = join(tmpProj, "exact.txt");
    const untouched = join(tmpProj, "untouched.txt");
    const original = "x^2 + y^2\nx2 xx2 X^2\n^x^2\n";
    const other = "no carets: x2\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "x\\^2", replacement: "SQ" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    // `y^2`, `X^2`, the leading `^` and every caret-free `x2` survive.
    expect(await readFile(file, "utf-8")).toBe("SQ + y^2\nx2 xx2 X^2\n^SQ\n");
    expect(await readFile(untouched, "utf-8")).toBe(other);
  });

  test("an unescaped leading `^` is an anchor, not a text caret", async () => {
    const file = join(tmpProj, "anchor.txt");
    await writeFile(file, "a^b a\n^a\n");

    // Contrast case: without the `m` flag `^a` matches only at the file start,
    // so the `a` after the text caret and the `^a` on line 2 are untouched.
    const { text } = await ashlrSearchReplaceRegex({ pattern: "^a", replacement: "A" });
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("A^b a\n^a\n");
  });
});

describe("literal pipe in pattern", () => {
  test("escaped `\\|` replaces only the exact `a|b`, not `a` or `b` alone", async () => {
    const file = join(tmpProj, "pipe.txt");
    const original = "a|b a b ab a||b a|b\n";
    await writeFile(file, original);

    const args = { pattern: "a\\|b", replacement: "OR" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("OR a b ab a||b OR\n");
  });

  test("a pipe inside a character class is a literal, not an alternation", async () => {
    const file = join(tmpProj, "pipe-class.txt");
    await writeFile(file, "a|b a b\n");

    await ashlrSearchReplaceRegex({ pattern: "a[|]b", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT a b\n");
  });
});

describe("literal parentheses in pattern", () => {
  test("escaped `\\(` and `\\)` replace only the exact `(a+b)`, not bare `a+b`", async () => {
    const file = join(tmpProj, "paren.txt");
    const original = "f(a+b) a+b (a+b) f(a+b)x (a b)\n";
    await writeFile(file, original);

    const args = { pattern: "\\(a\\+b\\)", replacement: "SUM" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("fSUM a+b SUM fSUMx (a b)\n");
  });

  test("unescaped parentheses are a capture group, parentheses in a class are literal", async () => {
    const file = join(tmpProj, "paren-class.txt");
    await writeFile(file, "(x) x\n");

    // Contrast case: `(x)` as a group matches both bare `x` and the `x` in `(x)`.
    const group = await ashlrSearchReplaceRegex({ pattern: "(x)", replacement: "Y", dryRun: true });
    expect(group.text).toContain("1 file, 2 replacements");

    await ashlrSearchReplaceRegex({ pattern: "[(]x[)]", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT x\n");
  });
});

describe("repeated literal match", () => {
  test("back-to-back occurrences of the same literal each get replaced", async () => {
    const file = join(tmpProj, "repeat.txt");
    const original = "foofoofoo and foo\n";
    await writeFile(file, original);

    const args = { pattern: "foo", replacement: "baz" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 4 replacements");
    expect(await readFile(file, "utf-8")).toBe("bazbazbaz and baz\n");
  });

  test("a self-overlapping literal matches left-to-right, not at every offset", async () => {
    const file = join(tmpProj, "overlap.txt");
    const original = "aaaaa\n";
    await writeFile(file, original);

    // `aa` can only match at offsets 0 and 2 — the global walk resumes
    // after each match, so the trailing `a` survives and no third match
    // is straddled out of the overlap.
    const args = { pattern: "aa", replacement: "BB" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("BBBBa\n");
  });
});

describe("literal backslash in replacement", () => {
  test("a backslash in the replacement is kept exactly (Windows path, `\\n`, `\\\\`)", async () => {
    const file = join(tmpProj, "path.txt");
    const original = "dir=ROOT\n";
    await writeFile(file, original);

    // Replacement is `C:\temp\new\\x` — JS String.replace gives backslashes
    // no special meaning, so `\t`, `\n` and `\\` must not be unescaped.
    const replacement = "C:\\temp\\new\\\\x";
    const args = { pattern: "ROOT", replacement };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(`dir=${replacement}\n`);
    expect(replacement).toHaveLength(14);
  });

  test("a backslash next to a capture reference stays literal", async () => {
    const file = join(tmpProj, "cap.txt");
    await writeFile(file, "name=foo\n");

    await ashlrSearchReplaceRegex({ pattern: "name=(\\w+)", replacement: "C:\\$1\\bin" });
    expect(await readFile(file, "utf-8")).toBe("C:\\foo\\bin\n");
  });
});
