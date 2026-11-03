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
