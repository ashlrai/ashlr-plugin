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

describe("literal search with a leading space", () => {
  test("the space is part of the match and surrounding text is preserved", async () => {
    const file = join(project, "space.txt");
    const untouched = join(project, "untouched.txt");
    // " foo" (space + foo) must be replaced including its space. `foo` at the
    // start of the file or glued to other text, `foobar`-style neighbours with
    // no leading space, and a tab-led `\tfoo` must all survive.
    const original = "foo one foo two\tfoo three\n a foo b\r\nxfoo foo\n";
    const expected = "foo one-BAR two\tfoo three\n a-BAR b\r\nxfoo-BAR\n";
    const other = "foo only, no leading space\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: " foo", replacement: "-BAR" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
    expect(await readFile(untouched)).toEqual(Buffer.from(other));
  });

  test("an empty replacement removes the leading space along with the word", async () => {
    const file = join(project, "remove.txt");
    await writeFile(file, "a foo, b foo.\n");

    const result = await ashlrSearchReplaceRegex({ pattern: " foo", replacement: "" });

    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("a, b.\n");
  });

  test("a file without the space-led literal is never rewritten", async () => {
    const file = join(project, "none.txt");
    const original = "foo\tfoo\nfoo\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: " foo", replacement: "X" });

    expect(result.text).toContain("0 files, 0 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);
  });
});
