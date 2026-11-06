import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-multiline-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("search and replace across lines", () => {
  test("plans and replaces each multiline capture while preserving unrelated bytes", async () => {
    const file = join(project, "records.txt");
    const original = "café before\r\nname=Ada\r\nvalue=12\r\nkeep this line\nname=Grace\nvalue=34\nlast line";
    const expected = "café before\r\nAda:12\r\nkeep this line\nGrace:34\nlast line";
    await writeFile(file, original);

    const args = {
      roots: [file],
      pattern: "^name=([A-Za-z]+)\\r?\\nvalue=(\\d+)$",
      replacement: "$1:$2",
      flags: "m",
    };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(dryRun.originalBytes).toBe(Buffer.byteLength(original));
    expect(dryRun.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.text).toContain("1 file written, 2 total replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original));
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
  });

  test("dotall matches spanning lines respect the cap and leave later blocks intact", async () => {
    const file = join(project, "blocks.txt");
    const original = "header\nBEGIN\nfirst\nEND\nbetween\nBEGIN\nsecond\nEND\nfooter\n";
    const expected = "header\n[first]\nbetween\nBEGIN\nsecond\nEND\nfooter\n";
    await writeFile(file, original);

    const args = {
      roots: [file],
      pattern: "BEGIN\\n(.*?)\\nEND",
      replacement: "[$1]",
      flags: "s",
      maxMatchesPerFile: 1,
    };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(dryRun.text).toContain("match cap hit");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.text).toContain("match cap hit");
    expect(await readFile(file)).toEqual(Buffer.from(expected));
  });
});
