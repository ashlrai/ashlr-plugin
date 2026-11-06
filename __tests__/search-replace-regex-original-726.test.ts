import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let tmpProj: string;

beforeEach(async () => {
  tmpProj = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-original-726-")));
  process.chdir(tmpProj);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpProj, { recursive: true, force: true });
});

describe("original 726 search and replace assertions", () => {

  test("escaped curly braces match only the literal brace text, not look-alikes", async () => {
    const file = join(tmpProj, "braces.txt");
    // `\{id\}` must match the exact text "{id}" — including the inner one
    // of "{{id}}", whose outer braces survive. Look-alikes "{ids}", "{}",
    // "{id", and the bare word "id" must stay byte-identical, and the
    // braces must not be read as a regex quantifier.
    const original = "x={id} {{id}} {ids} {} {id id café\r\nkeep {id}";
    const expected = "x=<ID> {<ID>} {ids} {} {id id café\r\nkeep <ID>";
    await writeFile(file, original);

    const args = { pattern: "\\{id\\}", replacement: "<ID>", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a brace quantifier is not literal: `o{2}` rewrites `oo` but leaves the text `o{2}`", async () => {
    const file = join(tmpProj, "quantifier.txt");
    const original = "foo o{2} fo\n";
    const expected = "fXX o{2} fo\n";
    await writeFile(file, original);

    const args = { pattern: "o{2}", replacement: "XX", roots: [file] };
    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });
});
