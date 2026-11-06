import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ashlrSearchReplaceRegex } from "../servers/search-replace-regex-server";

const originalCwd = process.cwd();
let project: string;

beforeEach(async () => {
  project = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-srr-brackets-")));
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(project, { recursive: true, force: true });
});

describe("literal square-bracket search", () => {
  test("escaped brackets replace only the exact bracketed text", async () => {
    const file = join(project, "brackets.txt");
    const untouched = join(project, "untouched.txt");
    // `[id]` must be replaced; the bare word `id`, the look-alike `[idx]`,
    // `[i]`, `[ID]`, and an unclosed `[id` must all survive, as must CRLF.
    const original = "keep id [id] [idx] [i] [ID] [id end\r\nrow[id]=id; [id][id]\n";
    const expected = "keep id (ID) [idx] [i] [ID] [id end\r\nrow(ID)=id; (ID)(ID)\n";
    const other = "no match: [ident] id\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "\\[id\\]", replacement: "(ID)" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
    expect(await readFile(untouched)).toEqual(Buffer.from(other));
  });

  test("unescaped brackets form a character class, escaped ones do not", async () => {
    const file = join(project, "class.txt");
    const original = "a[id]b i d [id]\n";
    await writeFile(file, original);

    // Contrast case: `[id]` as a regex is the class {i, d}, so it matches
    // single letters, not the bracketed text.
    const asClass = await ashlrSearchReplaceRegex({ pattern: "[id]", replacement: "_", dryRun: true });
    expect(asClass.text).toContain("1 file, 6 replacements");

    const literal = await ashlrSearchReplaceRegex({ pattern: "\\[id\\]", replacement: "_" });
    expect(literal.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("a_b i d _\n");
  });

  test("bracketed text with regex metacharacters inside is matched literally", async () => {
    const file = join(project, "meta.txt");
    await writeFile(file, "x[a.b] [a-b] [axb] y[a.b]\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "\\[a\\.b\\]", replacement: "<$&>" });

    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("x<[a.b]> [a-b] [axb] y<[a.b]>\n");
  });
});
