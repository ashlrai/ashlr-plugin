import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-unicode-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("regex replacement around Unicode", () => {
  test("replaces TODO markers across files and preserves all surrounding bytes", async () => {
    const first = join(project, "日本語.txt");
    const second = join(project, "notes.txt");
    const untouched = join(project, "untouched.txt");
    const originalFirst = "\uFEFF猫TODO(12)🧑‍💻e\u0301\r\nمرحبا TODO(3)世界\n";
    const expectedFirst = "\uFEFF猫DONE[12]🧑‍💻e\u0301\r\nمرحبا DONE[3]世界\n";
    const originalSecond = "🚀TODO(٤) café TODO(45)終";
    const expectedSecond = "🚀TODO(٤) café DONE[45]終";
    const originalUntouched = "é TODO(x) 🐈\r\n";
    await writeFile(first, originalFirst);
    await writeFile(second, originalSecond);
    await writeFile(untouched, originalUntouched);

    const args = { pattern: "TODO\\(([0-9]+)\\)", replacement: "DONE[$1]", flags: "u" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("2 files, 3 replacements");
    expect(dryRun.originalBytes).toBe(Buffer.byteLength(originalFirst) + Buffer.byteLength(originalSecond));
    expect(dryRun.newBytes).toBe(Buffer.byteLength(expectedFirst) + Buffer.byteLength(expectedSecond));
    expect(await readFile(first)).toEqual(Buffer.from(originalFirst));
    expect(await readFile(second)).toEqual(Buffer.from(originalSecond));
    expect(await readFile(untouched)).toEqual(Buffer.from(originalUntouched));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("2 files, 3 replacements");
    expect(result.text).toContain("2 files written, 3 total replacements");
    expect(result.originalBytes).toBe(dryRun.originalBytes);
    expect(result.newBytes).toBe(dryRun.newBytes);
    expect(await readFile(first)).toEqual(Buffer.from(expectedFirst));
    expect(await readFile(second)).toEqual(Buffer.from(expectedSecond));
    expect(await readFile(untouched)).toEqual(Buffer.from(originalUntouched));
  });

  test("leaves later TODO markers and Unicode intact when the match cap is reached", async () => {
    const file = join(project, "capped.txt");
    await writeFile(file, "🌍TODO(1)éTODO(2)e\u0301TODO(3)🐈\n");

    const result = await ashlrSearchReplaceRegex({
      pattern: "TODO\\(([0-9]+)\\)",
      replacement: "完了($1)",
      flags: "u",
      maxMatchesPerFile: 2,
    });

    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.text).toContain("match cap hit");
    expect(await readFile(file)).toEqual(Buffer.from("🌍完了(1)é完了(2)e\u0301TODO(3)🐈\n"));
  });
});
