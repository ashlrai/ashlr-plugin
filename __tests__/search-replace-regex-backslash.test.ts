import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-backslash-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("literal backslash search", () => {
  test("escaped backslash replaces only the backslash character", async () => {
    const file = join(project, "paths.txt");
    const untouched = join(project, "untouched.txt");
    // Only the three real `\` characters may change. Forward slashes, the
    // letters `n`/`t`/`d` that follow a backslash in escape sequences, the
    // pipe, and CRLF are all look-alikes that must survive byte-for-byte.
    const original = "C:\\dir\\file.txt /usr/bin n t d | a/b\r\nend\\\n";
    const expected = "C:/dir/file.txt /usr/bin n t d | a/b\r\nend/\n";
    const other = "no backslash here: C:/dir/file n t\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "\\\\", replacement: "/" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original));
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
    expect(await readFile(untouched)).toEqual(Buffer.from(other));
  });

  test("a file with no backslash is never counted or rewritten", async () => {
    const file = join(project, "none.txt");
    const original = Buffer.from("a/b n t u not here\r\n");
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "\\\\", replacement: "/" });
    expect(result.text).toContain("0 files, 0 replacements");
    expect(await readFile(file)).toEqual(original);
  });

  test("backslash before an escape letter is replaced alone, leaving the letter", async () => {
    const file = join(project, "escapes.txt");
    await writeFile(file, "a\\nb \\t c \\\\ d\n");

    // `\\` + `n` in the file is two characters, not a newline: only the
    // backslash goes. The doubled `\\` is two backslashes, so two matches.
    const result = await ashlrSearchReplaceRegex({ pattern: "\\\\", replacement: "|" });
    expect(result.text).toContain("1 file, 4 replacements");
    expect(await readFile(file, "utf-8")).toBe("a|nb |t c || d\n");
  });

  test("replacement of a literal backslash via $& is kept verbatim", async () => {
    const file = join(project, "wrap.txt");
    await writeFile(file, "x\\y z/y\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "\\\\", replacement: "<$&>" });
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("x<\\>y z/y\n");
  });
});
