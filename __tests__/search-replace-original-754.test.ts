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

describe("unicode literal in replacement", () => {
  test("a multi-byte replacement is preserved byte-for-byte, with no normalization", async () => {
    const file = join(tmpProj, "unicode.txt");
    const original = "name: NAME\n";
    await writeFile(file, original);

    // Decomposed "é" (e + combining U+0301), CJK in guillemets, an astral
    // emoji (surrogate pair), an arrow, and a ZWJ sequence — none of these
    // are `$` tokens, so the whole literal must pass through untouched:
    // no NFC normalization, no split surrogates, no mangled joiners.
    const replacement = "café «日本語» 🚀 → 🧑‍💻";
    const args = { pattern: "NAME", replacement };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    const expected = `name: ${replacement}\n`;
    expect(await readFile(file, "utf-8")).toBe(expected);
    // Byte-level check proves the NFD sequence and surrogate pairs survived
    // the utf-8 round-trip exactly as written.
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a literal unicode pattern matches, and a capture reference resolves inside a unicode replacement", async () => {
    const file = join(tmpProj, "unicode-pattern.txt");
    await writeFile(file, "café noir\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "café (\\w+)",
      replacement: "«$1» ☕",
    });
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("«noir» ☕\n");
  });
});
