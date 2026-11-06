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

describe("literal multiline replacement", () => {
  test("a replacement containing a real newline keeps it and the surrounding text", async () => {
    const file = join(tmpProj, "multiline.txt");
    const original = "head\nTOKEN tail\nlast\n";
    await writeFile(file, original);

    const args = { pattern: "TOKEN", replacement: "line one\nline two" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("head\nline one\nline two tail\nlast\n");
  });

  test("a multiline replacement is inserted at every match, including a trailing newline", async () => {
    const file = join(tmpProj, "multiline-many.txt");
    await writeFile(file, "a=X;b=X;\n");

    const { text } = await ashlrSearchReplaceRegex({ pattern: "X", replacement: "1\n2\n" });
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("a=1\n2\n;b=1\n2\n;\n");
  });
});
