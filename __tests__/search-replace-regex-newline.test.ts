import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-newline-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("literal newline in replacement", () => {
  test("a real newline in the replacement lands exactly once and surrounding text is preserved", async () => {
    const file = join(project, "list.txt");
    const untouched = join(project, "untouched.txt");
    // CRLF and a trailing blank line are look-alikes that must survive as-is.
    const original = "head a,b,c tail\r\nkeep this\n\n";
    const expected = "head a\nb\nc tail\r\nkeep this\n\n";
    const other = "no commas here\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    // The pattern is a comma; the replacement is a single LF.
    const args = { pattern: ",", replacement: "\n" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Exactly the original newlines plus one new per replacement; no CR added.
    expect(after.split("\n").length - 1).toBe(original.split("\n").length - 1 + 2);
    expect(after.split("\r").length).toBe(original.split("\r").length);
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(untouched)).toEqual(Buffer.from(other));
  });

  test("newline with text on both sides of the replacement keeps the match context", async () => {
    const file = join(project, "kv.txt");
    await writeFile(file, "a=1;b=2;\n");

    const result = await ashlrSearchReplaceRegex({ pattern: ";", replacement: ";\n  " });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("a=1;\n  b=2;\n  \n");
  });

  test("backslash-n typed in the replacement stays two characters, not a newline", async () => {
    const file = join(project, "esc.txt");
    await writeFile(file, "x,y\n");

    const result = await ashlrSearchReplaceRegex({ pattern: ",", replacement: "\\n" });
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("x\\ny\n");
  });
});
