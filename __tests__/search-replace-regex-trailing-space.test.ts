import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-space-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("literal search with a trailing space", () => {
  test("the space is part of the match and surrounding text is preserved", async () => {
    const file = join(project, "space.txt");
    // `foo ` consumes its space ("foo bar" -> "Xbar"); `foo` at end of line,
    // before a tab, before punctuation, and inside `foobar` must survive, as
    // must CRLF.
    const original = "foo bar\r\nfoo\nfoo\tx foo, foobar\n  foo  end foo \n";
    const expected = "Xbar\r\nfoo\nfoo\tx foo, foobar\n  X end X\n";
    await writeFile(file, original);

    const args = { pattern: "foo ", replacement: "X" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a replacement that keeps the space shows the match included it", async () => {
    const file = join(project, "keep.txt");
    await writeFile(file, "a foo b\nfoo\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "foo ", replacement: "bar " });

    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("a bar b\nfoo\n");
  });
});
