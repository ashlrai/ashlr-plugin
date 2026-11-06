import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ashlrSearchReplaceRegex,
  planSearchReplaceRegex,
  applyRegex,
} from "../servers/search-replace-regex-server";
import "../servers/search-replace-regex-server-handlers";
import { getTool } from "../servers/_tool-base";

let tmpProj: string;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

beforeEach(async () => {
  tmpProj = await mkdtemp(join(tmpdir(), "ashlr-srr-"));
  // Canonicalize so the clamp (which canonicalizes cwd) compares equal.
  tmpProj = realpathSync(tmpProj);
  process.chdir(tmpProj);
});

afterEach(async () => {
  if (process.cwd() !== ORIGINAL_CWD) {
    try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  }
  if (ORIGINAL_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
  await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
});

describe("original 775", () => {
  test("escaped brackets match literal square-bracket text, not a character class", async () => {
    const file = join(tmpProj, "brackets.txt");
    // "[tag]" is the intended match. The lone "t a g" letters beside it
    // are exactly what an unescaped `[tag]` — a character class — would
    // have consumed one by one. The half-bracket look-alikes "[tag" (no
    // closer) and "tag]" (no opener), plus the superset "[tags]", could
    // never match either way; their survival byte-for-byte proves only
    // the fully bracketed text was rewritten. café and CRLF guard the
    // tail.
    const original = "[tag] t a g [tag tag] [tags] café\r\nkeep [tag]\n";
    const expected = "X t a g [tag tag] [tags] café\r\nkeep X\n";
    await writeFile(file, original);

    const args = { pattern: "\\[tag\\]", replacement: "X", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("X t a g [tag tag] [tags] café\r");
    expect(lines[1]).toBe("keep X");
  });
});

describe("original 780", () => {
  test("escaped question mark matches a literal question mark, not a zero-or-one quantifier", async () => {
    const file = join(tmpProj, "question-mark.txt");
    // "a?b" is the intended match. "ab" and "b" sit beside it — an unescaped
    // `a?b` (zero-or-one `a` then `b`) would consume "ab" and "b" instead.
    // Their survival byte-for-byte proves the `\?` was treated as literal
    // punctuation, not a quantifier. The second occurrence sits mid-line
    // (between spaces) so offset placement is covered too.
    const original = "a?b ab b café\r\nx a?b y\nlast a?b";
    const expected = "X ab b café\r\nx X y\nlast X";
    await writeFile(file, original);

    const args = { pattern: "a\\?b", replacement: "X", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines2 = (await readFile(file, "utf-8")).split("\n");
    expect(lines2[0]).toBe("X ab b café\r");
    expect(lines2[1]).toBe("x X y");
    expect(lines2[2]).toBe("last X");
  });
});

describe("original 827", () => {
  test("a literal question mark written as a character class replaces only U+003F", async () => {
    const marked = join(tmpProj, "marks.txt");
    const clean = join(tmpProj, "marks-clean.txt");
    // `[?]` spells a literal question mark with no backslash — inside
    // `[…]` the mark is a plain class member, never a quantifier. Only
    // U+003F may be replaced; the full-width mark (U+FF1F), double
    // question (U+2047), question-exclamation (U+2048), interrobang
    // (U+203D), Arabic mark (U+061F), inverted mark (U+00BF) and the
    // emoji (U+2753) survive byte-for-byte, along with "color"/"colour"
    // (the spellings an unescaped `colou?r` quantifier would hit) and
    // the mark-free file.
    const markedOriginal =
      "ok? sure?? color colour colou？r\r\nnext? ⁇ ⁈ ‽ ؟ ¿ ❓\n?start end?\n";
    const markedExpected =
      "ok! sure!! color colour colou？r\r\nnext! ⁇ ⁈ ‽ ؟ ¿ ❓\n!start end!\n";
    const cleanOriginal = Buffer.from("no marks ？ ⁇ ‽ ؟ ¿ ❓ here café\n", "utf-8");
    await writeFile(marked, markedOriginal);
    await writeFile(clean, cleanOriginal);

    // Contrast: unescaped, `?` is the optional quantifier — `colou?r`
    // hits "color" and "colour" and never touches a real mark.
    const asQuantifier = await ashlrSearchReplaceRegex({
      pattern: "colou?r",
      replacement: "X",
      dryRun: true,
    });
    expect(asQuantifier.text).toContain("1 file, 2 replacements");
    expect(await readFile(marked)).toEqual(Buffer.from(markedOriginal, "utf-8"));

    const args = { pattern: "[?]", replacement: "!" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(marked)).toEqual(Buffer.from(markedOriginal, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(markedOriginal, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
    expect(await readFile(marked)).toEqual(Buffer.from(markedExpected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // The pure applyRegex path emits the same byte-for-byte result.
    const pure = applyRegex("a?b ¿ ？\n", /[?]/g, "!", 100);
    expect(pure.count).toBe(1);
    expect(pure.updated).toBe("a!b ¿ ？\n");

    // Same literal-mark search through the tool handler (JSON args path).
    await writeFile(marked, markedOriginal);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 6 replacements");
    expect(await readFile(marked)).toEqual(Buffer.from(markedExpected, "utf-8"));
  });

  test("a bare `?` with nothing to repeat is refused, leaving question marks untouched", async () => {
    const file = join(tmpProj, "bare-question.txt");
    // `?` alone is a quantifier with no preceding token — a literal-mark
    // search must be written `\?` or `[?]`. The refusal has to surface
    // rather than scanning nothing or rewriting the marks below.
    const original = Buffer.from("sure? really?? café\n", "utf-8");
    await writeFile(file, original);

    const args = { pattern: "?", replacement: "!", roots: [file] };
    const result = await planSearchReplaceRegex(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid regex/i);
    await expect(ashlrSearchReplaceRegex(args)).rejects.toThrow(/invalid regex/i);
    expect(await readFile(file)).toEqual(original);
  });
});

describe("original 862", () => {
  test("a bare backslash replacement writes exactly one 0x5C byte per match", async () => {
    const file = join(tmpProj, "bare-backslash-replacement.txt");
    // The replacement is a lone `\` — the minimal backslash literal. Each
    // match must gain exactly one 0x5C byte: never dropped, never doubled
    // to `\\`, and never fused with the next letter into an escape.
    const original = "a MARK b\nMARK c MARK\nd MARK\nnone here\n";
    const expected = "a \\ b\n\\ c \\\nd \\\nnone here\n";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "\\", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    expect(after.filter((b) => b === 0x5c).length).toBe(4);

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);

    // Pure path: beside a `$'` token the backslash still lands as a byte
    // while the post-match token expands to the empty match tail.
    const pure = applyRegex("x MARK y\n", /MARK/g, "\\$'", 100);
    expect(pure.count).toBe(1);
    expect(pure.updated).toBe("x \\ y\n");
  });
});
