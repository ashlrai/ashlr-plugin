/**
 * search-replace-regression.test.ts — literal dollar signs in replacements.
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
});
