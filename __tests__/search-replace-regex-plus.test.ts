import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-plus-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("literal plus-sign search", () => {
  test("escaped plus replaces only literal plus signs", async () => {
    const file = join(project, "plus.txt");
    const untouched = join(project, "untouched.txt");
    // Only the four `+` characters may change. Letters, digits, `-`, `=`,
    // spaces, CRLF and non-ASCII text around them must survive byte for byte.
    const original = "a+b a-b ab aab 1+1=2 c++ café+\r\nx = y\n";
    const expected = "a_b a-b ab aab 1_1=2 c__ café_\r\nx = y\n";
    const other = "no plus here: a b\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "\\+", replacement: "_" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
    expect(await readFile(untouched)).toEqual(Buffer.from(other));
  });

  test("unescaped plus is a quantifier, escaped plus is not", async () => {
    const file = join(project, "quantifier.txt");
    await writeFile(file, "a+b aab a+\n");

    // Contrast case: `a+` is "one or more a", so it matches the letters and
    // never needs a plus sign to be present.
    const asQuantifier = await ashlrSearchReplaceRegex({ pattern: "a+", replacement: "_", dryRun: true });
    expect(asQuantifier.text).toContain("1 file, 3 replacements");

    const literal = await ashlrSearchReplaceRegex({ pattern: "a\\+", replacement: "_" });
    expect(literal.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("_b aab _\n");
  });

  test("runs of plus signs match one at a time and the match can be reused", async () => {
    const file = join(project, "runs.txt");
    await writeFile(file, "x++y +++ +\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "\\+", replacement: "[$&]" });

    expect(result.text).toContain("1 file, 6 replacements");
    expect(await readFile(file, "utf-8")).toBe("x[+][+]y [+][+][+] [+]\n");
  });
});
