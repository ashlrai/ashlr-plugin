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

describe("literal Unicode in pattern", () => {
  test("a literal Unicode phrase is replaced and the surrounding text is preserved byte for byte", async () => {
    const file = join(tmpProj, "unicode.txt");
    const untouched = join(tmpProj, "unicode-untouched.txt");
    // Mix of CJK, an emoji (surrogate pair), a decomposed `é`, a BOM and CRLF around the target `café ☕`.
    const original = "﻿猫 café ☕ 🐈é\r\n日本語 café ☕ end\n";
    const other = "cafe ☕ café ☻ CAFÉ ☕\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "café ☕", replacement: "tea 🍵" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from("﻿猫 tea 🍵 🐈é\r\n日本語 tea 🍵 end\n"));
    // Near-misses (no accent, different symbol, upper case) are not matched.
    expect(await readFile(untouched)).toEqual(Buffer.from(other));
  });

  test("a precomposed literal does not match its decomposed lookalike", async () => {
    const file = join(tmpProj, "normalization.txt");
    const original = "café café\n";
    await writeFile(file, original);

    await ashlrSearchReplaceRegex({ pattern: "café", replacement: "CAFE" });
    expect(await readFile(file)).toEqual(Buffer.from("CAFE café\n"));
  });
});
