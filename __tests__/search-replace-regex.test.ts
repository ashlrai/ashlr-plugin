/**
 * search-replace-regex.test.ts — v1.20 multi-file regex search/replace.
 *
 * Covers:
 *   - dryRun: lists planned edits across 3 files, no writes
 *   - apply: same setup → files actually changed with correct counts
 *   - Unicode replacement preserves adjacent Unicode text
 *   - a literal Unicode search matches exact code points without normalization
 *   - u-flag matching never splits a surrogate pair; the Unicode
 *     replacement and an rg-only candidate file stay byte-identical
 *   - empty replacement removes matches while preserving surrounding
 *     text — via the direct call (regex and plain-literal patterns),
 *     and through the tool handler where `""` must satisfy the
 *     required-`replacement` check
 *   - escaped dollar signs remain literal in replacements
 *   - a literal replacement containing `$'` is written without inserting
 *     the remaining input after the match, and `$$'` lands verbatim
 *     beside an expanding whole-match token and a collapsing bare `$'`
 *   - a literal replacement containing `$&` lands verbatim beside an
 *     unescaped whole-match token, via the direct call and the tool handler
 *   - a literal replacement containing `$&` emits the same two bytes at
 *     every site even when match widths differ — alone or wrapped in
 *     brackets — via the direct call, the pure applyRegex path and the
 *     tool handler; a two-file plan prices each file's byte delta
 *     separately
 *   - a literal replacement containing `$$` lands both dollar signs
 *     verbatim beside an expanding whole-match token, via the direct
 *     call and the tool handler
 *   - backslashes in a literal replacement are preserved verbatim
 *   - a literal tab character in a replacement lands as a real tab on disk
 *   - a literal replacement containing Unicode lands byte-for-byte — a
 *     decomposed accent is never NFC-normalized and ZWJ / non-BMP
 *     characters keep their exact code points, via the direct call, the
 *     tool handler and the pure applyRegex path
 *   - a literal search containing a real tab replaces only the exact
 *     tab-containing match; space, double-space and \t-escape look-alikes
 *     stay byte-identical, via the direct call and the tool handler
 *   - a literal search containing spaces replaces the complete spaced
 *     phrase while partial matches — two-word prefixes and suffixes,
 *     lone words, and look-alikes joined by double spaces, tabs,
 *     hyphens, a newline or different case — stay byte-identical,
 *     via the direct call and the tool handler
 *   - a literal search with leading spaces replaces only matches that
 *     include those spaces; shorter runs, tabs and NBSPs stay identical
 *   - a literal carriage return in a replacement is written byte-for-byte,
 *     alone and next to existing CRLF line endings
 *   - a literal newline in a replacement is written as a real LF on disk
 *     and emitted unchanged by applyRegex
 *   - escaped `\$` in the pattern matches a literal dollar sign, not an
 *     end anchor
 *   - escaped `\^` matches only literal carets (even with the m flag, and
 *     between ordinary text) while caret look-alikes, line starts, and
 *     surrounding bytes stay identical
 *   - escaped `\+` in the pattern matches a literal plus sign, not a
 *     one-or-more quantifier, leaving quantifier look-alikes unchanged
 *   - a literal plus written as the `[+]` class (or escaped `\+` via the
 *     tool handler) replaces only U+002B — plus look-alikes (U+FF0B,
 *     U+FE62, U+2795, U+00B1) and a plus-free file stay byte-identical
 *   - a literal `C\+\+` token replaces only the two-plus spelling —
 *     single-C and single-plus look-alikes (C, CC, CCC, C+, Cpp,
 *     lowercase c++, U+FF0B) and a token-free file stay byte-identical,
 *     via the direct call and the tool handler
 *   - a `+` in the replacement is inserted verbatim beside plus signs
 *     the pattern never touched, via the direct call and applyRegex
 *   - escaped `\(`…`\)` in the pattern matches literal parentheses, not
 *     a capture group — via the direct call and the tool handler
 *   - a bare escaped `\|` replaces only the literal pipe character; bar
 *     look-alikes (U+FF5C, U+2502, U+00A6) and pipe-free files stay
 *     byte-identical
 *   - a literal pipe written as the `[|]` character class replaces only
 *     U+007C — bar look-alikes and a pipe-free file stay byte-identical,
 *     via the direct call and the tool handler
 *   - a bare `|` (empty alternation) is refused as zero-width rather
 *     than matching every position
 *   - a bare `-` replaces only the literal hyphen — the single-dash
 *     pattern must reach rg via `--regexp` instead of parsing as a flag;
 *     dash look-alikes (U+2010, U+2011, U+2013, U+2014, U+2212, U+FF0D)
 *     and a hyphen-free file stay byte-identical, via the direct call
 *     and the tool handler
 *   - nonmatching files remain unchanged alongside matching files
 *   - escaped punctuation in the pattern matches literally, leaving
 *     look-alike neighbors unchanged
 *   - a literal whose regex metacharacters sit next to ordinary text is
 *     replaced in full while nonliteral look-alikes remain unchanged
 *   - a literal stacking `{n,m}` braces, a `[x]` class, `?` and `.` is
 *     replaced in full while look-alikes matching the unescaped reading
 *     stay byte-identical, via the direct call and the tool handler
 *   - a bare `\.` replaces only literal periods; any other character
 *     (letters, digits, punctuation, Unicode) and dot-free files stay
 *     byte-identical, via the direct call and the tool handler
 *   - a literal period finds no match among dot look-alikes (U+2024,
 *     U+FF0E, U+00B7, U+2026) — the dot-free file stays byte-identical
 *   - escaped `\\` pairs in the pattern match a literal Windows path
 *     exactly — forward-slash, drive-letter, and prefix-only
 *     look-alikes stay byte-identical
 *   - a `\\n` pattern hits only the two-character text `\n`, never a
 *     real newline — via the tool handler
 *   - a bare `\\` pattern replaces only the literal backslash character;
 *     slash look-alikes (/, U+2216, U+29F5, U+FF3C) and a backslash-free
 *     file stay byte-identical, via the direct call and the tool handler
 *   - no-match tool calls report zero replacements and preserve file bytes
 *   - a literal present only as a filename, never in file contents, yields
 *     a zero-result tool call and an empty plan — every byte stays in place
 *   - a multiline literal whose halves never sit back-to-back finds no
 *     match — dry run and apply leave every byte in place
 *   - multiple matches on one line: all replaced, unrelated text unchanged
 *   - a literal repeated nonadjacently (same line and across lines) has
 *     every occurrence replaced while the intervening text stays identical
 *   - separated repeated literal matches across two files each get
 *     replaced while the gaps — look-alike text, CRLF and Unicode — stay
 *     byte-identical, via the tool handler and the pure applyRegex path
 *   - overlapping literal candidates (`aa` inside `aaa`, `aaaa`, `aaaaa`)
 *     collapse to leftmost non-overlapping matches — the shared-byte
 *     second candidate never fires; leftover `a`s, lone-`a` look-alikes
 *     and CRLF/Unicode neighbors stay byte-identical, via the direct
 *     call, the tool handler and the pure applyRegex path
 *   - anchored match at the beginning preserves the remaining text
 *   - unanchored literal match at offset 0 is replaced and the following
 *     text (CRLF, Unicode, prefix look-alikes, EOF tail) is preserved
 *   - m-flag `^…$` line anchor rewrites only fully matching lines —
 *     leading-space/trailing-text/mid-line look-alikes stay byte-identical
 *   - multiline match and replacement preserve surrounding text
 *   - match on the second line of a multiline file is replaced while
 *     the first line and the separating newline stay byte-identical
 *   - capture groups ($1 / $2, named $<k>) in replacement
 *   - whole-match replacement wraps multiple TODO markers on one line
 *   - whole-match replacement wraps TODO markers on separate lines
 *   - whole-match replacement wraps TODO markers on nonadjacent lines
 *     while preserving the intervening line exactly
 *   - whole-match replacement preserves Unicode adjacent to a TODO marker
 *   - case-sensitive default: a lowercase pattern rewrites only
 *     lowercase matches — uppercase look-alikes stay byte-identical,
 *     and an uppercase-only file never enters the candidate set
 *   - case-sensitive literal: an exact-case literal is replaced while
 *     lower/upper/mixed-case spellings stay byte-identical, via the
 *     direct call, the pure applyRegex path, and the tool handler
 *   - flags: i (case-insensitive), m (multiline anchors)
 *   - maxFiles cap: over-limit candidate set reports truncation warning
 *   - maxMatchesPerFile cap: per-file cap leaves extras in place
 *   - include glob restricts candidates
 *   - exclude glob removes candidates
 *   - binary refusal: PNG in roots is skipped
 *   - outside-cwd refusal on roots
 *   - invalid regex refusal without modifying the target; a JS-valid
 *     pattern ripgrep cannot scan is refused the same way
 *   - zero-width pattern refusal
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
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

// ---------------------------------------------------------------------------
// dryRun
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · dry run", () => {
  test("lists planned edits across 3 files without touching disk", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    const a = join(src, "a.ts");
    const b = join(src, "b.ts");
    const c = join(src, "c.ts");
    await writeFile(a, "const x = foo; const y = foo;\n");
    await writeFile(b, "function g() { return foo; }\n");
    await writeFile(c, "export { foo };\n");

    const before = {
      a: await readFile(a, "utf-8"),
      b: await readFile(b, "utf-8"),
      c: await readFile(c, "utf-8"),
    };

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "foo",
      replacement: "bar",
      dryRun: true,
    });

    expect(text).toContain("[ashlr__search_replace_regex]");
    expect(text).toContain("(dry run)");
    expect(text).toContain("3 files");
    expect(text).toContain("4 replacements"); // a has 2, b 1, c 1

    // Nothing changed on disk.
    expect(await readFile(a, "utf-8")).toBe(before.a);
    expect(await readFile(b, "utf-8")).toBe(before.b);
    expect(await readFile(c, "utf-8")).toBe(before.c);
  });
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · apply", () => {
  test("replaces an anchored match at the beginning and preserves the rest", async () => {
    const file = join(tmpProj, "version.txt");
    const original = "version=12; keep café\r\nversion=34; leave unchanged\n";
    const expected = "release=12; keep café\r\nversion=34; leave unchanged\n";
    await writeFile(file, original);

    const args = { pattern: "^version=(\\d+)", replacement: "release=$1" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("replaces a literal match at the very start of the file and preserves the following text", async () => {
    const file = join(tmpProj, "start.txt");
    // The literal sits at offset 0 with no anchor in the pattern. Its
    // neighbors — "headline" (same prefix, so a prefix-sloppy match would
    // hit it), a later standalone "head", and the CRLF/café tail — must
    // survive byte-for-byte.
    const original = "head: keep café\r\nheadline stays\nmid head end\n";
    const expected = "TOP: keep café\r\nTOPline stays\nmid TOP end\n";
    await writeFile(file, original);

    const args = { pattern: "head", replacement: "TOP", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert the first line explicitly: the replaced prefix and the
    // text after it (including the CR) must be exact.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("TOP: keep café\r");
  });

  test("replaces a literal match at the start of an unterminated one-line file", async () => {
    const file = join(tmpProj, "start-eof.txt");
    // Whole file is a single line with no trailing newline: the match at
    // offset 0 must leave the rest of the line intact to EOF.
    const original = "foo and then some tail text";
    const expected = "bar and then some tail text";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "foo", replacement: "bar", roots: [file] });
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("m-flag `^…$` line anchor rewrites only fully matching lines", async () => {
    const file = join(tmpProj, "anchored.txt");
    // Only lines whose ENTIRE content is `version=<digits>` match under
    // `^…$` + m — including the final line at EOF with no trailing
    // newline, where `$` anchors at end-of-input. The look-alike lines —
    // leading space, trailing text, leading char, non-digit value, and a
    // mid-line occurrence — must survive byte-for-byte, including the
    // CRLF-terminated near-miss (which neither rg --multiline nor the
    // JS regex can match).
    const original =
      "version=12\n" +
      " version=34\r\n" +
      "version=56 extra\n" +
      "xversion=78\n" +
      "version=x90\n" +
      "keep version=99 café\n" +
      "version=100";
    const expected =
      "release=12\n" +
      " version=34\r\n" +
      "version=56 extra\n" +
      "xversion=78\n" +
      "version=x90\n" +
      "keep version=99 café\n" +
      "release=100";
    await writeFile(file, original);

    const args = { pattern: "^version=(\\d+)$", replacement: "release=$1", flags: "m" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert each line individually so a mangled near-miss can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("release=12");
    expect(lines[1]).toBe(" version=34\r");
    expect(lines[2]).toBe("version=56 extra");
    expect(lines[3]).toBe("xversion=78");
    expect(lines[4]).toBe("version=x90");
    expect(lines[5]).toBe("keep version=99 café");
    expect(lines[6]).toBe("release=100");
  });

  test("replaces a multiline match while preserving surrounding text", async () => {
    const file = join(tmpProj, "multiline.txt");
    const original = "Header café\nBefore old first\nold second after\nFooter\n";
    const expected = "Header café\nBefore new first\nnew second\nnew third after\nFooter\n";
    await writeFile(file, original);

    const args = {
      pattern: "old first\\nold second",
      replacement: "new first\nnew second\nnew third",
      flags: "m",
    };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("replaces a pattern holding a real newline character, not the \\n escape", async () => {
    // The pattern string itself contains an LF byte, so the regex matches the
    // line break literally. Both look-alikes — the same words on one line and
    // the words split by a blank line — must stay untouched.
    const file = join(tmpProj, "literal-newline.txt");
    const original =
      "Header café\nBefore old first\nold second after\nold first old second\nold first\n\nold second\nFooter";
    const expected =
      "Header café\nBefore NEW after\nold first old second\nold first\n\nold second\nFooter";
    await writeFile(file, original);

    const args = { pattern: "old first\nold second", replacement: "NEW" };
    expect(args.pattern.includes("\n")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a literal search containing a real tab replaces only the exact tab-containing match", async () => {
    // The pattern holds a real 0x09 byte between the words. Look-alikes — a
    // single space, two spaces, a tab-then-space, NBSP, and the two-character
    // backslash-t text — must stay byte-identical.
    const file = join(tmpProj, "literal-tab.txt");
    const other = join(tmpProj, "no-tab.txt");
    const otherText = "key value\nkey  value\n";
    const original =
      "key\tvalue\nkey value\nkey  value\nkey\t value\nkey\u00a0value\nkey\\tvalue\nx key\tvalue y\n";
    const expected =
      "KV\nkey value\nkey  value\nkey\t value\nkey\u00a0value\nkey\\tvalue\nx KV y\n";
    await writeFile(file, original);
    await writeFile(other, otherText);

    const args = { pattern: "key\tvalue", replacement: "KV" };
    expect(args.pattern.includes("\t")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
    expect(await readFile(other, "utf-8")).toBe(otherText);

    // Through the tool handler, a second run finds nothing left to replace.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    await tool!.handler(args, { env: {} });
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a literal search containing spaces replaces only the complete spaced phrase", async () => {
    // The pattern holds real 0x20 bytes between the words. Every partial
    // match — the two-word prefix "red green", the two-word suffix
    // "green blue", a lone trailing "red", and look-alikes whose
    // separators differ (double spaces, tabs, hyphens, a newline, or a
    // capitalized first word) — must stay byte-identical. Only the two
    // complete "red green blue" occurrences may change. The second file
    // holds only partial phrases, so it never enters the candidate set.
    const file = join(tmpProj, "literal-spaces.txt");
    const partials = join(tmpProj, "partial-phrases.txt");
    const partialBytes = Buffer.from("red green\ngreen blue\nred blue\n", "utf-8");
    const original =
      "red green blue keep café\r\n" +
      "red green green blue mid\n" +
      "red  green  blue\n" +
      "red\tgreen\tblue red-green-blue\n" +
      "Red green blue red\n" +
      "tail red green blue";
    const expected =
      "RGB keep café\r\n" +
      "red green green blue mid\n" +
      "red  green  blue\n" +
      "red\tgreen\tblue red-green-blue\n" +
      "Red green blue red\n" +
      "tail RGB";
    await writeFile(file, original);
    await writeFile(partials, partialBytes);

    const args = { pattern: "red green blue", replacement: "RGB" };
    expect(args.pattern.includes(" ")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(partials)).toEqual(partialBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(partials)).toEqual(partialBytes);

    // Assert each line individually so a mangled partial can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("RGB keep café\r");
    expect(lines[1]).toBe("red green green blue mid");
    expect(lines[2]).toBe("red  green  blue");
    expect(lines[3]).toBe("red\tgreen\tblue red-green-blue");
    expect(lines[4]).toBe("Red green blue red");
    expect(lines[5]).toBe("tail RGB");

    // The complete phrase is gone; every partial remains.
    const after = await readFile(file, "utf-8");
    expect(after).not.toContain("red green blue");
    for (const partial of ["red green", "green blue", "red\tgreen\tblue", "red-green-blue", "Red green blue"]) {
      expect(after).toContain(partial);
    }

    // Same through the tool handler (JSON args path) — the spaces must
    // survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(partials)).toEqual(partialBytes);
  });

  test("a literal search with leading spaces replaces only matches that include those spaces", async () => {
    // The pattern "  indent" starts with two real spaces. Occurrences with
    // fewer leading spaces, a tab, an NBSP or none at all must stay
    // byte-identical; the spaces themselves are consumed with the match, and
    // a run of three spaces matches on its last two only.
    const file = join(tmpProj, "leading-spaces.txt");
    const original =
      "  indent one\n" +
      "indent two\n" +
      " indent three\n" +
      "\tindent four\n" +
      "\u00a0\u00a0indent five\n" +
      "x  indent six\n" +
      "   indent seven\n";
    const expected =
      "OUT one\n" +
      "indent two\n" +
      " indent three\n" +
      "\tindent four\n" +
      "\u00a0\u00a0indent five\n" +
      "xOUT six\n" +
      " OUT seven\n";
    await writeFile(file, original);

    const args = { pattern: "  indent", replacement: "OUT" };
    expect(args.pattern.startsWith("  ")).toBe(true);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Same through the tool handler.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a real-newline pattern replaces every exact multiline match and leaves a CRLF look-alike alone", async () => {
    // Two LF-joined matches are replaced; the CRLF-joined copy has a different
    // byte sequence between the words, so the LF pattern must not touch it.
    const file = join(tmpProj, "literal-newline-multi.txt");
    const original = "a\nfoo\nbar\nb\r\nfoo\r\nbar\r\nfoo\nbar\nz\n";
    const expected = "a\nFB\nb\r\nfoo\r\nbar\r\nFB\nz\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "foo\nbar", replacement: "FB" });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a literal CRLF pattern replaces only the exact CRLF-joined matches and leaves LF and bare-CR look-alikes alone", async () => {
    // Two CRLF-joined matches are replaced. The LF-joined copy, the bare-CR
    // copy, and every unrelated CRLF/LF line ending around them stay
    // byte-identical — including the CRLF just before and after each match.
    const file = join(tmpProj, "literal-crlf-multi.txt");
    const original = "a\r\nfoo\r\nbar\r\nb\nfoo\nbar\nc\rfoo\rbar\rfoo\r\nbar\r\nz café\n";
    const expected = "a\r\nFB\r\nb\nfoo\nbar\nc\rfoo\rbar\rFB\r\nz café\n";
    await writeFile(file, original);

    const args = { pattern: "foo\r\nbar", replacement: "FB" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Line-ending census: 3 CRLF survive (after a, after each FB); 7 LF total.
    const after = await readFile(file, "utf-8");
    expect(after.split("\r\n").length - 1).toBe(3);
    expect(after.split("\n").length - 1).toBe(7);

    // Same through the tool handler.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("replaces a match on the second line and preserves the first line and newline", async () => {
    const file = join(tmpProj, "second-line.txt");
    // The only real match sits on line 2. Line 1 is a near-miss
    // ("version=beta" — non-digit value) that must survive byte-for-byte
    // together with the newline separating the lines; the trailing third
    // line guards the tail of the file.
    const original = "version=beta keep café\nversion=42 tail\nlast line unchanged\n";
    const expected = "version=beta keep café\nrelease=42 tail\nlast line unchanged\n";
    await writeFile(file, original);

    const args = { pattern: "version=(\\d+)", replacement: "release=$1" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert each line individually so a mangled newline can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("version=beta keep café");
    expect(lines[1]).toBe("release=42 tail");
    expect(lines[2]).toBe("last line unchanged");
  });

  test("leaves a nonmatching file unchanged while replacing matches in another", async () => {
    const matching = join(tmpProj, "matching.txt");
    const unmatched = join(tmpProj, "unmatched.txt");
    const original = Buffer.from("café\r\nleave this alone\n", "utf-8");
    await writeFile(matching, "replace me\nreplace me\n");
    await writeFile(unmatched, original);

    const result = await ashlrSearchReplaceRegex({
      pattern: "replace me",
      replacement: "done",
    });

    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(matching, "utf-8")).toBe("done\ndone\n");
    expect(await readFile(unmatched)).toEqual(original);
  });

  test("empty replacement removes each match and preserves surrounding text", async () => {
    const file = join(tmpProj, "remove.txt");
    const original = "Before [remove:1] middle [remove:22] after\r\n";
    const expected = "Before  middle  after\r\n";
    await writeFile(file, original);

    const args = { pattern: "\\[remove:\\d+\\]", replacement: "" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("tool removes every match with an empty replacement, at every boundary", async () => {
    const file = join(tmpProj, "strip-markers.txt");
    // Five matches at every boundary — line start, an adjacent pair
    // mid-line, before trailing text, and EOF with no trailing newline —
    // so a stray byte left by removal would corrupt a neighbor. The
    // match-free middle line, the CRLF, and the café must survive
    // byte-for-byte. Exercised through the tool handler to prove `""`
    // satisfies the required-`replacement` check instead of being
    // treated as absent.
    const original = Buffer.from(
      "<cut>keep <cut><cut> mid <cut> café\r\nno markers on this line\n<cut>",
      "utf-8",
    );
    const expected = Buffer.from(
      "keep  mid  café\r\nno markers on this line\n",
      "utf-8",
    );
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "<cut>", replacement: "", roots: [file] };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(original);

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(expected);
  });

  test("empty replacement with m-flag removes whole lines and keeps neighboring lines intact", async () => {
    const file = join(tmpProj, "drop-lines.txt");
    // `^DEBUG:.*\n` eats each matching line plus its LF. The look-alikes
    // ("  DEBUG:" indented, "NODEBUG:", lowercase) and the CRLF/café line
    // must survive byte-for-byte, and the final line has no trailing newline.
    const original =
      "keep café\r\nDEBUG: one\n  DEBUG: indented\nDEBUG: two\nNODEBUG: x\ndebug: lower\nlast";
    const expected =
      "keep café\r\n  DEBUG: indented\nNODEBUG: x\ndebug: lower\nlast";
    await writeFile(file, original);

    const args = { pattern: "^DEBUG:.*\\n", replacement: "", flags: "m", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("empty literal replacement removes every literal occurrence and preserves surrounding text", async () => {
    const file = join(tmpProj, "strip-token.txt");
    // "note" is a plain literal — no regex metacharacters — so each exact
    // occurrence is deleted at every boundary: line start, an adjacent
    // pair, mid-line, and EOF with no trailing newline. The near-misses
    // ("NOTE", "not", "n0te"), the match-free middle line, the CRLF, and
    // café must survive byte-for-byte.
    const original =
      "notekeep notenote mid note café\r\n" +
      "NOTE not n0te no match\n" +
      "tail note";
    const expected =
      "keep  mid  café\r\n" +
      "NOTE not n0te no match\n" +
      "tail ";
    await writeFile(file, original);

    const args = { pattern: "note", replacement: "", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert each line individually so a mangled near-miss can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("keep  mid  café\r");
    expect(lines[1]).toBe("NOTE not n0te no match");
    expect(lines[2]).toBe("tail ");
  });

  test("empty literal replacement across files empties a match-only file and leaves other files untouched", async () => {
    const onlyMatches = join(tmpProj, "only-tags.txt");
    const mixed = join(tmpProj, "mixed-tags.txt");
    const unmatched = join(tmpProj, "no-tags.txt");
    // A file made solely of matches must be rewritten as a real empty
    // file (not skipped or left stale), the mixed file keeps its
    // surrounding text, and the unmatched file stays byte-identical.
    await writeFile(onlyMatches, "TODOTODO");
    await writeFile(mixed, "a TODO b\nTODO\nc TODO");
    const unmatchedBytes = Buffer.from("todo Todo TOD O\n", "utf-8");
    await writeFile(unmatched, unmatchedBytes);

    const result = await ashlrSearchReplaceRegex({
      pattern: "TODO",
      replacement: "",
      roots: [onlyMatches, mixed, unmatched],
    });

    expect(result.text).toContain("2 files, 5 replacements");
    expect(await readFile(onlyMatches, "utf-8")).toBe("");
    expect(await readFile(mixed, "utf-8")).toBe("a  b\n\nc ");
    expect(await readFile(unmatched)).toEqual(unmatchedBytes);
  });

  test("replaces a literal Unicode search while preserving surrounding text", async () => {
    const file = join(tmpProj, "unicode-literal.txt");
    const original = Buffer.from("前 café 🐈 後\r\ncafe\u0301 🐈 stays\n末 café 🐈!", "utf-8");
    const expected = Buffer.from("前 tea 後\r\ncafe\u0301 🐈 stays\n末 tea!", "utf-8");
    await writeFile(file, original);

    const args = { pattern: "café 🐈", replacement: "tea", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(original.length);
    expect(result.newBytes).toBe(expected.length);
    expect(await readFile(file)).toEqual(expected);
  });

  test("replaces Unicode text without changing adjacent Unicode characters", async () => {
    const file = join(tmpProj, "unicode.txt");
    const original = "é🧑‍💻猫🐈漢e\u0301\n";
    const expected = "é🧑‍💻犬🦊漢e\u0301\n";
    await writeFile(file, original);

    const args = { pattern: "猫🐈", replacement: "犬🦊", flags: "u" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("u-flag match keeps surrogate pairs whole — Unicode replacement and unrelated files stay byte-identical", async () => {
    const file = join(tmpProj, "cube.txt");
    const other = join(tmpProj, "unrelated.txt");
    // 🧊 is U+1F9CA: one code point but two UTF-16 code units. Under the
    // `u` flag `.` captures the whole emoji into $1; without it `.` would
    // match only the high surrogate and strand a lone low surrogate,
    // which would serialize to U+FFFD on write and corrupt the file.
    const original = "x🧊y café\nx🧊y e\u0301\ntail 🌍\n";
    const expected = "氷🧊🐈‍⬛y café\n氷🧊🐈‍⬛y e\u0301\ntail 🌍\n";
    // The `x` at end-of-line is an rg candidate (rg's `.` matches `\r`)
    // but a JavaScript near-miss (JS `.` excludes line terminators), so
    // the file is skipped and must be preserved byte-for-byte.
    const otherOriginal = Buffer.from("\uFEFF🧑‍💻 x\r\né漢字\n", "utf-8");
    await writeFile(file, original);
    await writeFile(other, otherOriginal);

    const args = { pattern: "x(.)", replacement: "氷$1🐈‍⬛", flags: "u" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(dryRun.text).toContain("1 candidate skipped");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(other)).toEqual(otherOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.text).toContain("1 candidate skipped");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(other)).toEqual(otherOriginal);
  });

  test("reports and replaces multiple distinct matches in one file", async () => {
    const file = join(tmpProj, "settings.txt");
    await writeFile(file, "first=1; second=22\nthird=333; keep\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "(\\w+)=(\\d+)",
      replacement: "$1:[$2]",
    });

    expect(text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "first:[1]; second:[22]\nthird:[333]; keep\n",
    );
  });

  test("replaces every match on a single line and preserves unrelated text", async () => {
    const file = join(tmpProj, "one-line.txt");
    // Four matches share one line — at the start, two adjacent, and at
    // the end — so rg reports the file once while four replacements are
    // owed. Unrelated words between them and a matchless second line
    // must survive byte-for-byte.
    const original = "foo keep foofoo keep2 foo\nno matches on this line\n";
    const expected = "bar keep barbar keep2 bar\nno matches on this line\n";
    await writeFile(file, original);

    const args = { pattern: "foo", replacement: "bar" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("applies regex across all matching files with correct counts", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    const a = join(src, "a.ts");
    const b = join(src, "b.ts");
    await writeFile(a, "logger.info('a');\nlogger.info('b');\n");
    await writeFile(b, "logger.info('c');\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "logger\\.info\\(",
      replacement: "log.info(",
    });

    expect(text).toContain("2 files");
    expect(text).toContain("3 replacements");
    expect(text).toContain("written");

    expect(await readFile(a, "utf-8")).toBe(
      "log.info('a');\nlog.info('b');\n",
    );
    expect(await readFile(b, "utf-8")).toBe("log.info('c');\n");
  });

  test("zero matches across files leaves their contents unchanged", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const files = [
      { path: join(src, "a.ts"), contents: Buffer.from("nothing here\n") },
      { path: join(src, "b.ts"), contents: Buffer.from("café\r\nstill nothing\n") },
    ];
    for (const file of files) await writeFile(file.path, file.contents);

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "willNotMatchAnywhere",
      replacement: "x",
    });
    expect(text).toContain("0 files");
    expect(text).toContain("0 replacements");
    for (const file of files) expect(await readFile(file.path)).toEqual(file.contents);
  });

  test("preserves file bytes when the pattern does not match", async () => {
    const file = join(tmpProj, "unchanged.txt");
    const original = Buffer.from("\uFEFFcafé\r\nsecond line\nlast line", "utf-8");
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({
      pattern: "absent-pattern",
      replacement: "replacement",
    });

    expect(result.text).toContain("0 files, 0 replacements");
    expect(result.originalBytes).toBe(0);
    expect(result.newBytes).toBe(0);
    expect(await readFile(file)).toEqual(original);
  });

  test("reports no replacements for regex near matches in dry run and apply", async () => {
    const file = join(tmpProj, "versions.txt");
    const original = Buffer.from("version=12x\r\nversion=x34\n", "utf-8");
    await writeFile(file, original);

    const args = { pattern: "^version=\\d+$", replacement: "version=0", flags: "m" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("0 files, 0 replacements");
    expect(dryRun.originalBytes).toBe(0);
    expect(dryRun.newBytes).toBe(0);
    expect(await readFile(file)).toEqual(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("0 files, 0 replacements");
    expect(result.originalBytes).toBe(0);
    expect(result.newBytes).toBe(0);
    expect(await readFile(file)).toEqual(original);
  });

  test("tool reports a successful no-match result and preserves file bytes", async () => {
    const file = join(tmpProj, "document.txt");
    const original = Buffer.from("\uFEFFcafé\r\nunchanged content\n", "utf-8");
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dryRun of [true, false]) {
      const result = await tool!.handler(
        { pattern: "missing-[0-9]+", replacement: "changed", roots: [file], dryRun },
        { env: {} },
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain("0 files, 0 replacements");
      expect(await readFile(file)).toEqual(original);
    }
  });

  test("absent literal search leaves look-alike text byte-identical in dry run and apply", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    // Each file nearly contains "needle_value": wrong case, split by a space,
    // truncated, or with a different separator.
    const files = [
      { path: join(src, "case.txt"), contents: Buffer.from("NEEDLE_VALUE\r\nNeedle_Value\n") },
      { path: join(src, "split.txt"), contents: Buffer.from("needle _value café\nneedle\n_value") },
      { path: join(src, "other.txt"), contents: Buffer.from("needle-value needle_valu\n") },
    ];
    for (const file of files) await writeFile(file.path, file.contents);

    for (const dryRun of [true, false]) {
      const result = await ashlrSearchReplaceRegex({
        pattern: "needle_value",
        replacement: "changed",
        dryRun,
      });
      expect(result.text).toContain("0 files, 0 replacements");
      expect(result.originalBytes).toBe(0);
      expect(result.newBytes).toBe(0);
      for (const file of files) expect(await readFile(file.path)).toEqual(file.contents);
    }
  });

  test("tool leaves file bytes untouched when the literal only names a file, absent from its contents", async () => {
    // "needle_token" is the FILENAME of one file but appears in no file's
    // contents — rg only surfaces content matches, so the filename must
    // not turn the file into a candidate. The other file carries
    // near-misses (wrong case, split, wrong separator, digit look-alike)
    // that a sloppy match would hit; every byte must stay in place.
    const named = join(tmpProj, "needle_token.txt");
    const nearMiss = join(tmpProj, "near-miss.txt");
    const namedBytes = Buffer.from("contents without the literal café\r\n", "utf-8");
    const nearMissBytes = Buffer.from(
      "NEEDLE_TOKEN needle_ token needle-token needle_t0ken\n",
      "utf-8",
    );
    await writeFile(named, namedBytes);
    await writeFile(nearMiss, nearMissBytes);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dryRun of [true, false]) {
      const result = await tool!.handler(
        { pattern: "needle_token", replacement: "changed", dryRun },
        { env: {} },
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain("0 files, 0 replacements");
      expect(await readFile(named)).toEqual(namedBytes);
      expect(await readFile(nearMiss)).toEqual(nearMissBytes);
    }
  });

  test("a multiline literal finds no match when its halves never sit back-to-back", async () => {
    const file = join(tmpProj, "halves.txt");
    // The literal "tail\nhead" (real LF) only matches when "tail" ends a
    // line and "head" opens the very next one. The file dangles every
    // near-miss: the halves share one line, sit a blank line apart, appear
    // in reversed order, ride a CRLF boundary, carry a trailing char on
    // "tail", and pad "head" with a leading space. A sloppy scan that
    // tolerates any of those would false-positive; every byte must stay
    // in place.
    const original = Buffer.from(
      "tail head\r\ntail\r\nhead\ntail\n\nhead\nhead\ntail\ntailx\nhead\ntail\n head café\n",
      "utf-8",
    );
    await writeFile(file, original);

    const args = { pattern: "tail\nhead", replacement: "changed", roots: [file] };
    expect(args.pattern.includes("\n")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);

    for (const dryRun of [true, false]) {
      const result = await ashlrSearchReplaceRegex({ ...args, dryRun });
      expect(result.text).toContain("0 files, 0 replacements");
      expect(result.originalBytes).toBe(0);
      expect(result.newBytes).toBe(0);
      expect(await readFile(file)).toEqual(original);
    }
  });

  test("leaves a ripgrep candidate unchanged when JavaScript finds no matches", async () => {
    const file = join(tmpProj, "invoice.txt");
    const original = Buffer.from("invoice=١٢٣\r\nkeep café\n", "utf-8");
    await writeFile(file, original);

    // Ripgrep's \d includes Unicode digits; JavaScript's \d matches ASCII digits.
    const result = await ashlrSearchReplaceRegex({
      pattern: "invoice=\\d+",
      replacement: "invoice=0",
    });

    expect(result.text).toContain("0 files, 0 replacements, 1 candidate skipped");
    expect(result.originalBytes).toBe(0);
    expect(result.newBytes).toBe(0);
    expect(await readFile(file)).toEqual(original);
  });

  test("escaped punctuation changes only the literal match, not look-alike neighbors", async () => {
    const file = join(tmpProj, "dotted.txt");
    // "foo.bar" is the intended match. "fooXbar" and "foobar" sit beside
    // it — an unescaped `.` would match "fooXbar" too, so their survival
    // byte-for-byte proves the `\.` was treated as literal punctuation
    // and not as the any-character metacharacter.
    const original = "foo.bar fooXbar foobar café\nkeep foo.bar\n";
    const expected = "match fooXbar foobar café\nkeep match\n";
    await writeFile(file, original);

    const args = { pattern: "foo\\.bar", replacement: "match" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("escaped pipe matches literal pipe text, not regex alternation", async () => {
    const file = join(tmpProj, "pipe.txt");
    // An unescaped `a|b` would match every "a" and every "b". With `\|`,
    // only the exact "a|b" text is replaced; lone "a", "b", "a b" survive.
    const original = "a|b a b a b|a|b ab\n";
    const expected = "X a b a b|X ab\n";
    await writeFile(file, original);

    const args = { pattern: "a\\|b", replacement: "X" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a bare escaped pipe replaces only the literal pipe character", async () => {
    const piped = join(tmpProj, "table.txt");
    const clean = join(tmpProj, "clean.txt");
    // An unescaped `|` is an empty alternation that matches everywhere.
    // With `\|` only U+007C is replaced; the full-width bar (U+FF5C), box
    // drawing bar (U+2502), broken bar (U+00A6), slash, "I", "l" and "1"
    // look-alikes must survive byte-for-byte, as must the pipe-free file.
    const pipedOriginal = "a|b｜c│d¦e/f I l 1\r\n|start end|\n||\n";
    const pipedExpected = "a-b｜c│d¦e/f I l 1\r\n-start end-\n--\n";
    const cleanOriginal = Buffer.from("no bars ｜ │ ¦ here café\n", "utf-8");
    await writeFile(piped, pipedOriginal);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\|", replacement: "-" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(piped)).toEqual(Buffer.from(pipedOriginal, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(await readFile(piped)).toEqual(Buffer.from(pipedExpected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a literal pipe written as a character class replaces only pipe characters", async () => {
    const piped = join(tmpProj, "class-pipe.txt");
    const clean = join(tmpProj, "class-clean.txt");
    // `[|]` spells a literal pipe with no backslash — inside `[…]` the
    // bar is a plain class member, never an alternation. Only U+007C may
    // be replaced; the full-width bar (U+FF5C), box-drawing bar (U+2502),
    // broken bar (U+00A6) and every other byte around them must survive
    // byte-for-byte, as must the pipe-free file.
    const pipedOriginal = "k|v a|b｜c│d¦e/f\r\n|x| | trailing|\n";
    const pipedExpected = "k=v a=b｜c│d¦e/f\r\n=x= = trailing=\n";
    const cleanOriginal = Buffer.from("no bars ｜ │ ¦ here café\n", "utf-8");
    await writeFile(piped, pipedOriginal);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "[|]", replacement: "=" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(piped)).toEqual(Buffer.from(pipedOriginal, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(pipedOriginal, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(pipedExpected, "utf-8"));
    expect(await readFile(piped)).toEqual(Buffer.from(pipedExpected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Same literal-pipe search through the tool handler (JSON args path).
    await writeFile(piped, pipedOriginal);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 6 replacements");
    expect(await readFile(piped)).toEqual(Buffer.from(pipedExpected, "utf-8"));
  });

  test("escaped pipe through the tool handler replaces only pipes in a table row", async () => {
    const table = join(tmpProj, "row.md");
    const clean = join(tmpProj, "row-clean.md");
    // Markdown-table shape: cell separators are U+007C, while U+FF5C,
    // U+2502 and U+00A6 look-alikes sit inside cells and must survive.
    // `\|\|` consumes only an adjacent pair, so the lone pipes remain.
    const original = "| a | b｜c | d│e |\n|---|---|\n| x || y ¦ z |\n";
    const expected = "| a | b｜c | d│e |\n|---|---|\n| x ; y ¦ z |\n";
    const cleanOriginal = Buffer.from("no pipes ｜ │ ¦ here\n", "utf-8");
    await writeFile(table, original);
    await writeFile(clean, cleanOriginal);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "\\|\\|", replacement: ";" };
    const dry = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dry.isError).not.toBe(true);
    expect(dry.content[0]?.text).toContain("1 file, 1 replacement");
    expect(await readFile(table)).toEqual(Buffer.from(original, "utf-8"));

    const res = await tool!.handler(args, { env: {} });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]?.text).toContain("1 file, 1 replacement");
    expect(await readFile(table)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("escaped question mark matches only literal question marks, not an optional quantifier", async () => {
    const file = join(tmpProj, "question.txt");
    const clean = join(tmpProj, "question-clean.txt");
    // An unescaped `?` makes the previous token optional; `\?` must match
    // only U+003F. "color"/"colour" (what `colou?r` would hit), the
    // full-width mark (U+FF1F), double question (U+2047), Arabic question
    // mark (U+061F), inverted mark (U+00BF) and the emoji (U+2753) all
    // survive byte-for-byte, as does the question-mark-free file.
    const original = "color colour colou?r\r\nwhy? ？ ⁇ ؟ ¿ ❓\n??\n";
    const expected = "color colour colou!r\r\nwhy! ？ ⁇ ؟ ¿ ❓\n!!\n";
    const cleanOriginal = Buffer.from("no marks ？ ⁇ ؟ ¿ ❓ here café\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\?", replacement: "!" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Same literal search through the tool handler (JSON args path), now
    // inside a word: `colou\?r` must not match "color" or "colour".
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(
      { pattern: "colou\\?r", replacement: "X" },
      { env: {} },
    );
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(
      Buffer.from("color colour X\r\nwhy? ？ ⁇ ؟ ¿ ❓\n??\n", "utf-8"),
    );
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("escaped caret matches literal caret text, not a line boundary", async () => {
    const file = join(tmpProj, "caret.txt");
    // Even with the m flag, `\^` must match only the "^" character. Line
    // starts (which an unescaped `^` would hit) must stay untouched.
    const original = "a^b\n^start\nplain\n";
    const expected = "a-b\n-start\nplain\n";
    await writeFile(file, original);

    const args = { pattern: "\\^", replacement: "-", flags: "m" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("literal caret between ordinary text is replaced; look-alikes and anchors stay put", async () => {
    const file = join(tmpProj, "caret-embedded.txt");
    const clean = join(tmpProj, "caret-free.txt");
    // "x^2" is the target. Beside it: caret look-alikes (U+02C6, U+FF3E,
    // U+2227) and line starts that an unescaped `^2` would anchor on. Only
    // the real caret may change; accents and CRLF/EOF edges must survive.
    const original = "x^2 xˆ2 x＾2 x∧2 café\r\n2 x^2 mid\nlast x^2";
    const expected = "x**2 xˆ2 x＾2 x∧2 café\r\n2 x**2 mid\nlast x**2";
    const cleanOriginal = Buffer.from("x2 ˆ ＾ ∧ plain\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "x\\^2", replacement: "x**2", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("escaped plus matches a literal plus sign, not a one-or-more quantifier", async () => {
    const file = join(tmpProj, "plus.txt");
    // "a+b" is the intended match. Beside it sit "ab", "aab", and "aaab" —
    // exactly the strings the unescaped `a+b` (one-or-more `a`s, then `b`)
    // would have consumed instead. Their survival byte-for-byte proves the
    // `\+` was treated as literal punctuation, not a quantifier. The
    // literal recurs at a line start after a CRLF and at EOF with no
    // trailing newline so boundary placement is covered too.
    const original = "a+b ab aab aaab café\r\na+b mid\nlast a+b";
    const expected = "X ab aab aaab café\r\nX mid\nlast X";
    await writeFile(file, original);

    const args = { pattern: "a\\+b", replacement: "X", roots: [file] };
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
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("X ab aab aaab café\r");
    expect(lines[1]).toBe("X mid");
    expect(lines[2]).toBe("last X");
  });

  test("bare escaped plus replaces only plus signs, leaving digits, minus, and equals untouched", async () => {
    const file = join(tmpProj, "bare-plus.txt");
    // Every `+` (including a `++` run) becomes "P"; neighbors that an
    // unescaped `+` quantifier or a loose class could disturb — digits,
    // "-", "=", and a lone-letter "c" — must survive byte-for-byte.
    const original = "1+1=2 a++b c-d 3 + 4\n+x\n";
    const expected = "1P1=2 aPPb c-d 3 P 4\nPx\n";
    await writeFile(file, original);

    const args = { pattern: "\\+", replacement: "P", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect((await readFile(file, "utf-8")).includes("+")).toBe(false);
  });

  test("a literal plus written as a character class replaces only U+002B, not plus look-alikes", async () => {
    const plus = join(tmpProj, "class-plus.txt");
    const clean = join(tmpProj, "class-plus-clean.txt");
    // `[+]` spells a literal plus with no backslash. Only U+002B may be
    // replaced; the full-width plus (U+FF0B), small plus (U+FE62), heavy
    // plus emoji (U+2795), plus-minus (U+00B1) and the digits/letters an
    // unescaped quantifier would touch must survive byte-for-byte, as must
    // the plus-free file.
    const original = "1+1 a++b c＋d e﹢f g➕h i±j caf\u00e9\r\n+x+ end+\n";
    const expected = "1P1 aPPb c＋d e﹢f g➕h i±j caf\u00e9\r\nPxP endP\n";
    const cleanOriginal = Buffer.from("no plus ＋ ﹢ ➕ ± here\n", "utf-8");
    await writeFile(plus, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "[+]", replacement: "P" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(plus)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(plus)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Same search through the tool handler, with the escaped spelling.
    await writeFile(plus, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ pattern: "\\+", replacement: "P" }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 6 replacements");
    expect(await readFile(plus)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a literal `C++` token replaces only the two-plus spelling, not single-C or single-plus look-alikes", async () => {
    const file = join(tmpProj, "cplusplus.txt");
    const clean = join(tmpProj, "cplusplus-clean.txt");
    // `C\+\+` spells the language name: both plus signs are literal. Read
    // as a quantifier, `C+` would have eaten "C", "CC" and "CCC" — their
    // survival proves the escapes held. "C+", "Cpp", lowercase "c++" and
    // the full-width "C＋＋" are not the token. "C+++x" holds the token
    // as a prefix: the literal match consumes exactly "C++" and the
    // residual "+x" survives — only the two literal plus signs move.
    const original =
      "C++ C CC CCC C+ Cpp c++ C＋＋ café\r\n" +
      "C++ (C++) C+++x\n" +
      "tail C++";
    const expected =
      "X C CC CCC C+ Cpp c++ C＋＋ café\r\n" +
      "X (X) X+x\n" +
      "tail X";
    const cleanOriginal = Buffer.from("C CC C+ Cpp c++ C＋＋\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "C\\+\\+", replacement: "X" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("X C CC CCC C+ Cpp c++ C＋＋ café\r");
    expect(lines[1]).toBe("X (X) X+x");
    expect(lines[2]).toBe("tail X");

    // Same search through the tool handler (JSON args path) — the escaped
    // plus signs must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a `+` in the replacement is inserted literally beside untouched plus signs", async () => {
    const file = join(tmpProj, "plus-replacement.txt");
    // `+` carries no special meaning in a JS replacement string, so each
    // inserted plus must land verbatim — beside the two pre-existing
    // pluses in "a++b" that the pattern never touched.
    const original = "1 PLUS 1=2 a++b PLUS café\r\nlast PLUS\n";
    const expected = "1 + 1=2 a++b + café\r\nlast +\n";
    await writeFile(file, original);

    const args = { pattern: "PLUS", replacement: "+", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Three inserted pluses plus the two originals in "a++b" — no more.
    expect(after.split("+").length - 1).toBe(5);

    // The pure in-memory transform inserts the same verbatim plus.
    const pure = applyRegex("x PLUS y\n", /PLUS/g, "+", 100);
    expect(pure).toEqual({ updated: "x + y\n", count: 1, capped: false });
  });

  test("literal asterisk patterns replace only ASCII asterisks", async () => {
    const file = join(tmpProj, "asterisk.txt");
    const clean = join(tmpProj, "asterisk-free.txt");
    const original = "*start a**b end* café\r\nfullwidth ＊ small ﹡ star ★\n";
    const expected = "Xstart aXXb endX café\r\nfullwidth ＊ small ﹡ star ★\n";
    const cleanOriginal = Buffer.from("a aa ＊ ﹡ ★\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\*", replacement: "X" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original));
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ pattern: "[*]", replacement: "X" }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("escaped parentheses match literal parens, not capture-group syntax", async () => {
    const file = join(tmpProj, "parens.txt");
    // "foo(bar)" is the intended match, written `foo\(bar\)` so each paren
    // is a literal. Unescaped, `foo(bar)` is a capture group and would hit
    // the paren-free "foobar" instead. The other look-alikes — "foo(baz)"
    // (parens but different contents), "foo[bar]" (different brackets),
    // "foo(bar" (open paren, no close), and a bare "(bar)" with no prefix —
    // must survive byte-for-byte, café and CRLF included.
    const original = "foo(bar) foobar foo(baz) foo[bar] foo(bar (bar) café\r\nkeep foo(bar)\n";
    const expected = "HIT foobar foo(baz) foo[bar] foo(bar (bar) café\r\nkeep HIT\n";
    await writeFile(file, original);

    const args = { pattern: "foo\\(bar\\)", replacement: "HIT", roots: [file] };
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
    expect(lines[0]).toBe("HIT foobar foo(baz) foo[bar] foo(bar (bar) café\r");
    expect(lines[1]).toBe("keep HIT");

    // Same through the tool handler (JSON args path) — the escaped parens
    // must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a lone escaped paren replaces only that exact parenthesis, never a bracket look-alike", async () => {
    const file = join(tmpProj, "lone-paren.txt");
    const clean = join(tmpProj, "lone-paren-clean.txt");
    // `\(` alone must hit only U+0028. The closing paren, square and curly
    // brackets, full-width parens (U+FF08/U+FF09) and the small-form paren
    // (U+FE59) must survive byte-for-byte, as must the paren-free file.
    const original = "f(x) g(y)) [a] {b} （c） ﹙d café\r\n(start\n";
    const expected = "f<x) g<y)) [a] {b} （c） ﹙d café\r\n<start\n";
    const cleanOriginal = Buffer.from("no parens ） ］ here café\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\(", replacement: "<", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // The closing paren and the `[(]` class spelling behave the same way.
    await writeFile(file, original);
    const close = await ashlrSearchReplaceRegex({ ...args, pattern: "\\)", replacement: ">" });
    expect(close.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("f(x> g(y>> [a] {b} （c） ﹙d café\r\n(start\n");

    await writeFile(file, original);
    const viaClass = await ashlrSearchReplaceRegex({ ...args, pattern: "[(]" });
    expect(viaClass.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("literal match updates both adjacent occurrences with no gap between them", async () => {
    const file = join(tmpProj, "adjacent.txt");
    // "a.b" sits back-to-back with itself; the second match starts exactly
    // where the first ends. The look-alike "aXb" after them must survive.
    const original = "a.ba.b aXb\n";
    const expected = "ZZ aXb\n";
    await writeFile(file, original);

    const args = { pattern: "a\\.b", replacement: "Z" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("overlapping literal candidates collapse to leftmost non-overlapping matches", async () => {
    // `aa` inside `aaa` matches once, not twice: a global regex scans
    // left-to-right, so the match at offset 0 consumes its two bytes and
    // the overlapping candidate at offset 1 is never evaluated — the
    // trailing `a` is copied through untouched. The same rule gives
    // `aaaa` two replacements (offsets 0 and 2) and `aaaaa` two plus a
    // leftover. The second file holds look-alikes with no `aa` run —
    // lone `a`s, `aba`, `bab`, `aA` — so it must stay byte-identical and
    // never enter the candidate set.
    const file = join(tmpProj, "overlap.txt");
    const other = join(tmpProj, "no-double-a.txt");
    const original =
      "aaa\n" + // one match at offset 0, leftover a → "ba"
      "aaaa\n" + // non-overlapping matches at 0 and 2 → "bb"
      "aaaaa\n" + // matches at 0 and 2, leftover a → "bba"
      "a aa aax aa\n" + // lone `a`s plus the `aa` prefix of `aax`
      "café aa\r\n"; // CRLF + Unicode neighbors stay put
    const expected =
      "ba\n" +
      "bb\n" +
      "bba\n" +
      "a b bx b\n" +
      "café b\r\n";
    const otherText = "a a aba bab aA\n";
    await writeFile(file, original);
    await writeFile(other, otherText);

    const args = { pattern: "aa", replacement: "b" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    // 1 + 2 + 2 + 3 + 1 = 9 — a sliding-window scan would report more.
    expect(dryRun.text).toContain("1 file, 9 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(other, "utf-8")).toBe(otherText);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 9 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(other, "utf-8")).toBe(otherText);

    // Through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 9 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(other, "utf-8")).toBe(otherText);

    // The pure in-memory path applies the same left-to-right rule.
    const once = applyRegex("aaa", /aa/g, "b", 100);
    expect(once.updated).toBe("ba");
    expect(once.count).toBe(1);
    expect(once.capped).toBe(false);
    expect(applyRegex("aaaa", /aa/g, "b", 100).updated).toBe("bb");
    expect(applyRegex("aaaaa", /aa/g, "b", 100).updated).toBe("bba");
  });

  test("literal match repeated nonadjacently replaces every occurrence and leaves intervening text unchanged", async () => {
    const file = join(tmpProj, "nonadjacent-literal.txt");
    // "id-7" recurs four times, never touching itself: twice on line 1 with
    // text between, then once on each later line around a matchless line.
    // The gaps hold near-misses ("id-8", "id_7", "ID-7") plus CRLF/café
    // bytes — none contain the literal, so each gap must stay identical.
    const gaps = [" id-8 id_7 ", " ID-7 café ", "\r\nno match here\r\n", " tail "];
    const original = `id-7${gaps[0]}id-7${gaps[1]}\nx${gaps[2]}id-7${gaps[3]}id-7\n`;
    const expected = `N${gaps[0]}N${gaps[1]}\nx${gaps[2]}N${gaps[3]}N\n`;
    await writeFile(file, original);

    const args = { pattern: "id-7", replacement: "N", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Every match is gone and each intervening gap survives verbatim.
    expect(after).not.toContain("id-7");
    for (const gap of gaps) expect(after).toContain(gap);
  });

  test("separated repeated literal matches each get replaced and the text between them is preserved", async () => {
    // "acme" recurs five times across two files — at offset 0, mid-line,
    // and at EOF with no trailing newline — each pair separated by a
    // different gap: ordinary text, a full line of look-alikes, and a
    // CRLF-terminated line holding Unicode. The third file carries only
    // look-alikes ("ACME", "acmé", "acm3", "ac me"), so it never becomes
    // a candidate and every gap must survive byte-for-byte.
    const a = join(tmpProj, "separated-a.txt");
    const b = join(tmpProj, "separated-b.txt");
    const c = join(tmpProj, "separated-c.txt");
    const originalA = "acme first { café } acme\nkeep ACME acmé acm3 line\nthird gap acme";
    const expectedA = "X first { café } X\nkeep ACME acmé acm3 line\nthird gap X";
    const originalB = "pre acme\r\nintervening 猫 untouched\r\nacme tail\n";
    const expectedB = "pre X\r\nintervening 猫 untouched\r\nX tail\n";
    const originalC = Buffer.from("ACME acmé acm3 ac me\n", "utf-8");
    await writeFile(a, originalA);
    await writeFile(b, originalB);
    await writeFile(c, originalC);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "acme", replacement: "X" };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("2 files, 5 replacements");
    expect(await readFile(a)).toEqual(Buffer.from(originalA, "utf-8"));
    expect(await readFile(b)).toEqual(Buffer.from(originalB, "utf-8"));

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("2 files, 5 replacements");
    expect(await readFile(a)).toEqual(Buffer.from(expectedA, "utf-8"));
    expect(await readFile(b)).toEqual(Buffer.from(expectedB, "utf-8"));
    expect(await readFile(c)).toEqual(originalC);

    // The pure in-memory transform lands the same replacements and
    // copies each intervening gap verbatim.
    const { updated, count, capped } = applyRegex(originalA, /acme/g, "X", 100);
    expect(count).toBe(3);
    expect(capped).toBe(false);
    expect(updated).toBe(expectedA);
  });

  test("a bare escaped period replaces only literal periods, never other characters", async () => {
    const file = join(tmpProj, "period.txt");
    // Every non-period neighbor — letters, digits, space, dash, underscore,
    // comma, and the unicode "·" — is a character an unescaped `.` would
    // also consume. Only the two real periods may change.
    const original = "v1.2 v1x2 a-b a_b a,b a·b end.\nno dots here\n";
    const expected = "v1_2 v1x2 a-b a_b a,b a·b end_\nno dots here\n";
    await writeFile(file, original);

    const args = { pattern: "\\.", replacement: "_", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("tool: escaped period skips a file with no literal period", async () => {
    const dotless = join(tmpProj, "dotless.txt");
    const dotted = join(tmpProj, "dotted-too.txt");
    // Without a literal period an unescaped `.` would match every character
    // here; the file must stay byte-identical and never be counted.
    const dotlessOriginal = Buffer.from("abc xyz 123 café\r\n", "utf-8");
    await writeFile(dotless, dotlessOriginal);
    await writeFile(dotted, "a.b\n");

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "\\.", replacement: "!" };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 1 replacement");
    expect(await readFile(dotted, "utf-8")).toBe("a.b\n");

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 1 replacement");
    expect(await readFile(dotted, "utf-8")).toBe("a!b\n");
    expect(await readFile(dotless)).toEqual(dotlessOriginal);
  });

  test("a literal period matches nothing in a file of unrelated look-alike characters", async () => {
    const file = join(tmpProj, "dot-lookalikes.txt");
    // No ASCII "." anywhere — only characters that resemble or stand in
    // for one: U+2024 ONE DOT LEADER, U+FF0E FULLWIDTH FULL STOP, U+00B7
    // MIDDLE DOT, U+2026 HORIZONTAL ELLIPSIS, and "1x2" where a decimal
    // separator could sit. An unescaped `.` (or any non-literal reading
    // of the pattern) would consume them all; `\.` must report zero
    // replacements and leave every byte in place.
    const original = Buffer.from(
      "one․two three．four a·b wait… café\r\nversion 1x2 tail\n",
      "utf-8",
    );
    await writeFile(file, original);

    const args = { pattern: "\\.", replacement: "_", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("0 files, 0 replacements");
    expect(dryRun.originalBytes).toBe(0);
    expect(dryRun.newBytes).toBe(0);
    expect(await readFile(file)).toEqual(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("0 files, 0 replacements");
    expect(result.originalBytes).toBe(0);
    expect(result.newBytes).toBe(0);
    expect(await readFile(file)).toEqual(original);
  });

  test("a bare hyphen replaces only literal hyphens, leaving look-alike dashes and other characters untouched", async () => {
    const file = join(tmpProj, "hyphens.txt");
    const lookalikes = join(tmpProj, "dash-look-alikes.txt");
    // A lone `-` is the riskiest literal to hand to rg — as a bare
    // positional it would parse as a flag, and inside a character class
    // it means "range" — so the `--regexp` hand-off must deliver it as a
    // pattern and only U+002D may be replaced. The hyphens sit at every
    // boundary: mid-token, a `--` run, line start, line end, mid-line
    // between spaces, and EOF with no trailing newline. Everything else
    // is a look-alike or ordinary byte that must survive byte-for-byte:
    // U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2013 EN DASH, U+2014
    // EM DASH, U+2212 MINUS SIGN, U+FF0D FULLWIDTH HYPHEN-MINUS, plus
    // letters, digits, "_", "=", CRLF and the café. The second file
    // holds only look-alikes — its name even carries ASCII hyphens its
    // contents lack — so it never enters the candidate set at all.
    const original =
      "a-b‐c‑d–e—f−g－h a_b=c keep café\r\n" +
      "-start a--b end-\n" +
      "mid - dash\n" +
      "tail-";
    const expected =
      "a~b‐c‑d–e—f−g－h a_b=c keep café\r\n" +
      "~start a~~b end~\n" +
      "mid ~ dash\n" +
      "tail~";
    const lookalikeBytes = Buffer.from(
      "a‐b a‑b a–b a—b a−b a－b café\r\n",
      "utf-8",
    );
    await writeFile(file, original);
    await writeFile(lookalikes, lookalikeBytes);

    const args = { pattern: "-", replacement: "~" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    // The look-alike file must not even surface as a skipped candidate.
    expect(dryRun.text).not.toContain("skipped");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("a~b‐c‑d–e—f−g－h a_b=c keep café\r");
    expect(lines[1]).toBe("~start a~~b end~");
    expect(lines[2]).toBe("mid ~ dash");
    expect(lines[3]).toBe("tail~");
    // No U+002D remains in the rewritten file — every look-alike survives.
    expect(lines.join("\n")).not.toContain("-");

    // Same through the tool handler (JSON args path) — a lone `-` must
    // survive transport and still match only the literal hyphen.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);
  });

  test("escaped backslashes in the pattern match a literal Windows path exactly", async () => {
    const file = join(tmpProj, "windows-paths.txt");
    // `C:\old\dir` on disk is written `C:\\old\\dir` in the pattern —
    // every literal backslash needs its own `\\` escape or JS would read
    // `\o` as an Annex-B identity escape while rg's Rust regex rejects
    // the pattern outright. The look-alikes — forward slashes, a
    // different drive letter, and the bare `C:\old` prefix — must
    // survive byte-for-byte, café and CRLF included.
    const original =
      "src=C:\\old\\dir keep café\r\n" +
      "fwd=C:/old/dir\n" +
      "other=D:\\old\\dir\n" +
      "prefix=C:\\old alone\n" +
      "dst=C:\\old\\dir";
    const expected =
      "src=D:\\new\\dir keep café\r\n" +
      "fwd=C:/old/dir\n" +
      "other=D:\\old\\dir\n" +
      "prefix=C:\\old alone\n" +
      "dst=D:\\new\\dir";
    await writeFile(file, original);

    const args = { pattern: "C:\\\\old\\\\dir", replacement: "D:\\new\\dir", roots: [file] };
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
    expect(lines[0]).toBe("src=D:\\new\\dir keep café\r");
    expect(lines[1]).toBe("fwd=C:/old/dir");
    expect(lines[2]).toBe("other=D:\\old\\dir");
    expect(lines[3]).toBe("prefix=C:\\old alone");
    expect(lines[4]).toBe("dst=D:\\new\\dir");
  });

  test("tool: `\\\\n` pattern hits only the two-character text, never a real newline", async () => {
    const file = join(tmpProj, "backslash-n.txt");
    // The file holds the two characters `\` + `n` — as they appear in
    // code and docs — alongside real LF/CRLF line breaks. Pattern `\\n`
    // (escaped backslash, then a literal `n`) must rewrite only the
    // two-character sequences; if the escape collapsed to `\n` the
    // regex would eat every newline and weld the lines together.
    const original = "first \\n second\nkeep \\n café\r\nlast line\nend \\n";
    const expected = "first <NL> second\nkeep <NL> café\r\nlast line\nend <NL>";
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "\\\\n", replacement: "<NL>", roots: [file] };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // All three real line breaks survive — nothing consumed a newline.
    const after = await readFile(file, "utf-8");
    expect(after.split("\n").length - 1).toBe(3);
  });

  test("bare `\\\\` pattern replaces only literal backslashes, leaving slash look-alikes untouched", async () => {
    const file = join(tmpProj, "bare-backslash.txt");
    const clean = join(tmpProj, "no-backslash.txt");
    // Pattern `\\\\` in JS source is the regex `\\` — one literal backslash.
    // Look-alikes: forward slash, U+2216 set minus, U+29F5 reverse solidus
    // operator, U+FF3C fullwidth reverse solidus. A pair of adjacent
    // backslashes counts as two matches.
    const original =
      "a\\b c/d café\r\n" +
      "fwd=/ \u2216 \u29F5 \uFF3C\n" +
      "pair=\\\\ end\\";
    const expected =
      "a|b c/d café\r\n" +
      "fwd=/ \u2216 \u29F5 \uFF3C\n" +
      "pair=|| end|";
    const cleanText = "only / and \u2216 here\n";
    await writeFile(file, original);
    await writeFile(clean, cleanText);
    const cleanBytes = await readFile(clean);

    const args = { pattern: "\\\\", replacement: "|", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanBytes);

    // Round trip through the tool handler on a fresh copy.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanBytes);
  });

  test("literal with regex metacharacters beside ordinary text replaces only the full literal", async () => {
    const file = join(tmpProj, "meta-literal.txt");
    const lookalikes = join(tmpProj, "nonliteral.txt");
    // The intended match is the literal "a.b(c)+d" — `.`, a paren pair,
    // and a `+` all sitting next to plain letters. Read as a pattern
    // instead of as a literal, `a.b(c)+d` means "a", any char, "b",
    // one-or-more "c", then "d" — exactly what "aXbcd" and "aYbccd"
    // would have matched. Their survival byte-for-byte proves every
    // metacharacter in the literal was treated as itself, and the
    // replacement lands only where the full literal — metacharacters
    // included — stood. The second file holds only nonliteral
    // occurrences, so it never enters the candidate set at all.
    const original = "a.b(c)+d aXbcd keep café\r\naYbccd mid\nlast a.b(c)+d";
    const expected = "R aXbcd keep café\r\naYbccd mid\nlast R";
    const lookalikeBytes = Buffer.from("aZbcd aWbcccd café\r\n", "utf-8");
    await writeFile(file, original);
    await writeFile(lookalikes, lookalikeBytes);

    const args = { pattern: "a\\.b\\(c\\)\\+d", replacement: "R" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("R aXbcd keep café\r");
    expect(lines[1]).toBe("aYbccd mid");
    expect(lines[2]).toBe("last R");

    // The full literal — metacharacters and all — is gone everywhere;
    // both nonliteral look-alikes remain.
    const after = await readFile(file, "utf-8");
    expect(after).not.toContain("a.b(c)+d");
    expect(after).toContain("aXbcd");
    expect(after).toContain("aYbccd");

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("literal stacking braces, class, question mark and dot replaces only the complete literal", async () => {
    const file = join(tmpProj, "meta-stack.txt");
    const lookalikes = join(tmpProj, "meta-stack-nonliteral.txt");
    // The intended match is the literal "id{2,4}[x]?.conf" — a `{n,m}`
    // repetition, a character class, a `?` quantifier, and a `.` all
    // stacked in one string. Read as a pattern instead of as a literal,
    // `id{2,4}[x]?.conf` means "i", two-to-four "d"s, an optional "x",
    // any char, then "conf" — exactly what "iddx.conf", "idd.conf",
    // "idddx_conf", and "iddddx;conf" would have matched. Their survival
    // byte-for-byte proves every metacharacter was treated as itself:
    // the braces kept their comma, the brackets stayed literal square
    // brackets, the question mark stayed punctuation, and the dot stayed
    // a dot — so the replacement lands only where the complete literal
    // stood. "idx.conf" (a lone "d") matches neither reading and is the
    // control. The second file holds only nonliteral occurrences, so it
    // never enters the candidate set at all.
    const original =
      "id{2,4}[x]?.conf iddx.conf keep café\r\n" +
      "idd.conf idx.conf mid\n" +
      "last id{2,4}[x]?.conf";
    const expected =
      "R iddx.conf keep café\r\n" +
      "idd.conf idx.conf mid\n" +
      "last R";
    const lookalikeBytes = Buffer.from("idddx_conf iddddx;conf café\r\n", "utf-8");
    await writeFile(file, original);
    await writeFile(lookalikes, lookalikeBytes);

    const args = { pattern: "id\\{2,4\\}\\[x\\]\\?\\.conf", replacement: "R" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("R iddx.conf keep café\r");
    expect(lines[1]).toBe("idd.conf idx.conf mid");
    expect(lines[2]).toBe("last R");

    // The complete literal — braces, brackets, question mark and all —
    // is gone everywhere; every nonliteral look-alike remains.
    const after = await readFile(file, "utf-8");
    expect(after).not.toContain("id{2,4}[x]?.conf");
    for (const near of ["iddx.conf", "idd.conf", "idx.conf"]) {
      expect(after).toContain(near);
    }

    // Same through the tool handler (JSON args path) — the stacked
    // escapes must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });
});

// ---------------------------------------------------------------------------
// Capture groups
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · capture groups", () => {
  test("expands capture groups separately for every match on one line", async () => {
    const file = join(tmpProj, "pairs.txt");
    const original = "start [red:1] / [blue:22][green:333] end\r\nuntouched\n";
    const expected = "start 1=red / 22=blue333=green end\r\nuntouched\n";
    await writeFile(file, original);

    const args = { pattern: "\\[([a-z]+):(\\d+)\\]", replacement: "$2=$1" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("escapes dollar signs in literal replacement text", async () => {
    const file = join(tmpProj, "prices.txt");
    const original = "Before TOKEN; between TOKEN; after café\r\n";
    const expected = "Before cost $5, literal $1 and $&; between cost $5, literal $1 and $&; after café\r\n";
    await writeFile(file, original);

    // $$ escapes each dollar, even before a valid capture or whole-match token.
    const args = { pattern: "(TOKEN)", replacement: "cost $$5, literal $$1 and $$&" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("inserts a literal $' via $$' instead of expanding it to the text after the match", async () => {
    const file = join(tmpProj, "literal-dollar-quote.txt");
    // `$'` is JS's "text after the match" token; `$$'` must yield the two
    // characters `$'`. The text after each marker (" tail", "!") must stay
    // in place and must not be duplicated into the replacement.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say it's $'ok tail\r\nit's $'ok! café\nlast it's $'ok";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "it's $$'ok", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("literal replacement containing $' is written without inserting the remaining input", async () => {
    const file = join(tmpProj, "remaining-input.txt");
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    await writeFile(file, original);

    // A bare `$'` is JS's "text after the match" token. applyRegex evaluates
    // the replacement against the match substring alone — the match spans
    // that whole substring — so the token resolves to the empty string. A
    // naive `source.replace(re, replacement)` would splice the remaining
    // input after each match into the output; the per-match walk never sees
    // it, and each tail (" tail", "!", EOF) stays exactly in place.
    const args = { pattern: "MARK", replacement: "it's $'ok", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    const expected = "say it's ok tail\r\nit's ok! café\nlast it's ok";
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Written literally via `$$'`, the two characters `$'` land verbatim —
    // still with no remaining input spliced in.
    await writeFile(file, original);
    const literal = await ashlrSearchReplaceRegex({ ...args, replacement: "it's $$'ok" });
    expect(literal.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "say it's $'ok tail\r\nit's $'ok! café\nlast it's $'ok",
    );
  });

  test("literal replacement containing $' lands verbatim beside an expanding token and a collapsing bare $'", async () => {
    const file = join(tmpProj, "literal-dollar-quote-mixed.txt");
    // `$$'` must yield the two characters `$'`; the adjacent `$&` still
    // expands to the whole match, and the trailing bare `$'` still
    // collapses to the empty string (per-match scoping) instead of
    // dragging the remaining input behind it. Treating `$$'` as the
    // token would splice " tail" / "!" in place of the literal; treating
    // every `$` as escaped would leave "MARK" unexpanded.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say $'=MARK tail\r\n$'=MARK! café\nlast $'=MARK";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "$$'=$&$'", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("inserts a literal $1 via $$1 even when the pattern has a capture group", async () => {
    const file = join(tmpProj, "literal-dollar-one.txt");
    await writeFile(file, "name=alice\nname=bob\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "name=(\\w+)", replacement: "name=$$1", flags: "" });
    expect(result.text).toContain("1 file, 2 replacements");
    // Exactly the two characters "$1", not the captured group.
    expect(await readFile(file, "utf-8")).toBe("name=$1\nname=$1\n");
  });

  test("literal replacement containing $& lands verbatim beside an expanding whole-match token", async () => {
    const file = join(tmpProj, "literal-dollar-amp.txt");
    // `$$&` must yield the two characters `$&`; a bare `$&` still expands
    // to the whole match. Keeping both in one replacement proves the
    // escape is honored without disabling the token: treating `$$&` as
    // the token would splice the match text in place of the literal, and
    // treating every `$` as escaped would leave "MARK" unexpanded.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say $&=MARK tail\r\n$&=MARK! café\nlast $&=MARK";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "$$&=$&", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("literal replacement containing $& emits the same two bytes at every site, whatever the match width", async () => {
    const file = join(tmpProj, "literal-dollar-amp-widths.txt");
    // `n=\d+` matches three different widths — `n=1` (3B), `n=42` (4B),
    // `n=300` (5B). `$$&` must emit the identical two characters `$&` at
    // every site: if the escape were misread as the whole-match token,
    // each site would keep its own digits and the outputs would differ.
    // The look-alikes — a non-digit value, a different name, an
    // uppercase `N`, and a dangling `n=` — must survive byte-for-byte.
    const original = "n=1; n=42; n=300 café\r\nn=x stays; m=5 stays; N=9 stays; lone n=\n";
    const expected = "$&; $&; $& café\r\nn=x stays; m=5 stays; N=9 stays; lone n=\n";
    await writeFile(file, original);

    const args = { pattern: "n=\\d+", replacement: "$$&", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Uniform literal: three sites, one spelling, no surviving digits
    // on the rewritten line.
    expect(after.split("$&").length - 1).toBe(3);
    expect(after.split("\r\n")[0]).not.toMatch(/\d/);

    // Wrapped in ordinary text the literal still lands byte-for-byte —
    // brackets around `$$&` don't bleed it into an expansion.
    await writeFile(file, original);
    const wrapped = await ashlrSearchReplaceRegex({ ...args, replacement: "[$$&]" });
    expect(wrapped.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "[$&]; [$&]; [$&] café\r\nn=x stays; m=5 stays; N=9 stays; lone n=\n",
    );

    // Pure path: the same width-varying matches collapse to one literal
    // per site.
    const { updated, count } = applyRegex(original, /n=\d+/g, "$$&", 100);
    expect(count).toBe(3);
    expect(updated).toBe(expected);

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("literal replacement containing $$ lands both dollar signs verbatim beside an expanding token", async () => {
    const file = join(tmpProj, "literal-dollar-pair.txt");
    // A literal `$$` on disk (a shell PID token, a price) is written
    // `$$$$` in the replacement — each `$$` pair is JS's escape for one
    // `$`. Both dollar signs must land side by side: a single `$$`
    // collapses to one `$`, and treating every `$` as escaped would
    // leave the adjacent `$&` unexpanded instead of splicing in the
    // whole match.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say $$=MARK tail\r\n$$=MARK! café\nlast $$=MARK";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "$$$$=$&", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // A replacement that is only the escaped pair emits exactly the
    // two-character literal — both dollar signs and nothing else.
    await writeFile(file, original);
    const only = await ashlrSearchReplaceRegex({ ...args, replacement: "$$$$" });
    expect(only.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("say $$ tail\r\n$$! café\nlast $$");

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("escaped dollar in the pattern matches a literal $, not an end anchor", async () => {
    const file = join(tmpProj, "literal-dollar-search.txt");
    // `\$` must hit only the literal "$" characters. If it were treated as
    // an end anchor, it would instead match at line/file end and append.
    const original = "cost $5 and $10\nplain 5 and 10\nend$\n";
    const expected = "cost USD5 and USD10\nplain 5 and 10\nendUSD\n";
    await writeFile(file, original);

    const args = { pattern: "\\$", replacement: "USD", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("literal `\\$` replaces only U+0024, leaving dollar look-alikes and end anchors alone", async () => {
    const file = join(tmpProj, "literal-dollar-lookalikes.txt");
    // Full-width ＄ (U+FF04), small ﹩ (U+FE69) and ¤ (U+00A4) are not "$".
    // Adjacent "$$" is two literals; trailing "$" at EOF (no newline) is
    // literal, and lines without a "$" are not touched by an anchor reading.
    const original = "a$b $$ ＄1 ﹩2 ¤3\nno money here\nUS$\nlast$";
    const expected = "aSb SS ＄1 ﹩2 ¤3\nno money here\nUSS\nlastS";
    await writeFile(file, original);

    const args = { pattern: "\\$", replacement: "S", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);

    // Same through the tool handler (JSON args path), with the m flag.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, flags: "m" }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a file with only dollar look-alikes stays byte-identical under a literal `\\$` search", async () => {
    const file = join(tmpProj, "only-lookalikes.txt");
    const original = "＄1\n﹩2\n¤3\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "\\$", replacement: "S", roots: [file] });
    expect(result.text).toContain("0 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
  });

  test("literal dollar search via `[$]`, `\\$\\$` and `\\$5` replaces only real dollar signs across files", async () => {
    const a = join(tmpProj, "dollar-multi-a.txt");
    const b = join(tmpProj, "dollar-multi-b.txt");
    const c = join(tmpProj, "dollar-multi-c.txt");
    // Look-alikes: ＄ (U+FF04), ﹩ (U+FE69), ¤ (U+00A4); "S" and "5" are plain.
    const lookalikes = "＄5 ﹩5 ¤5 S5 5\n";
    await writeFile(a, "pay $5 now $$ end$\nS5\n");
    await writeFile(b, "$ alone\nx$y$z\n");
    await writeFile(c, lookalikes);

    // `[$]` is a literal class: every U+0024, never an end anchor.
    const cls = await ashlrSearchReplaceRegex({ pattern: "[$]", replacement: "#", roots: [a, b, c], dryRun: true });
    expect(cls.text).toContain("2 files, 7 replacements");
    expect(await readFile(a, "utf-8")).toBe("pay $5 now $$ end$\nS5\n");

    await ashlrSearchReplaceRegex({ pattern: "[$]", replacement: "#", roots: [a, b, c] });
    expect(await readFile(a, "utf-8")).toBe("pay #5 now ## end#\nS5\n");
    expect(await readFile(b, "utf-8")).toBe("# alone\nx#y#z\n");
    expect(await readFile(c)).toEqual(Buffer.from(lookalikes, "utf-8"));

    // Multi-character literal: `\$\$` hits the adjacent pair only, `\$5` the priced token only.
    await writeFile(a, "pay $5 now $$ end$\nS5\n");
    await ashlrSearchReplaceRegex({ pattern: "\\$\\$", replacement: "DD", roots: [a] });
    expect(await readFile(a, "utf-8")).toBe("pay $5 now DD end$\nS5\n");
    await writeFile(a, "pay $5 now $$ end$\nS5\n");
    await ashlrSearchReplaceRegex({ pattern: "\\$5", replacement: "FIVE", roots: [a] });
    expect(await readFile(a, "utf-8")).toBe("pay FIVE now $$ end$\nS5\n");
  });

  test("applyRegex with an escaped dollar pattern replaces only literal dollars", () => {
    const { updated, count } = applyRegex("a$b\nc$\nd＄e\n", /\$/g, "-", 100);
    expect(count).toBe(2);
    expect(updated).toBe("a-b\nc-\nd＄e\n");
  });

  test("literal replacement containing a backslash is preserved verbatim", async () => {
    const file = join(tmpProj, "backslash-replacement.txt");
    // A backslash in the replacement is not an escape: `\n`, `\t`, `\\` and
    // a trailing `\` must land on disk as written, never as a newline, tab,
    // or collapsed backslash. Neighbors stay byte-identical.
    const original = "path=SLASH keep\nother=SLASH\nnone here\n";
    const replacement = "C:\\dir\\new\\t\\\\x\\";
    const expected = `path=${replacement} keep\nother=${replacement}\nnone here\n`;
    await writeFile(file, original);

    const args = { pattern: "SLASH", replacement, roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    expect(after.split("\\").length - 1).toBe(2 * 6);
    expect(after).not.toContain("\t");
  });

  test("backslash replacement is preserved verbatim through the tool handler", async () => {
    const file = join(tmpProj, "backslash-handler.txt");
    const original = "dir=SLASH\nkeep\n";
    const replacement = "C:\\new\\table\\\\";
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const result = await tool!.handler({ pattern: "SLASH", replacement, roots: [file] }, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(`dir=${replacement}\nkeep\n`);
  });
  test("literal carriage return in replacement is preserved byte-for-byte on disk", async () => {
    const file = join(tmpProj, "cr-replacement.txt");
    const original = "keep\r\nfirst MATCH second\nthird MATCH fourth\r\n";
    const expected = "keep\r\nfirst \r second\nthird \r fourth\r\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "MATCH", replacement: "\r", roots: [file] });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    // Exactly the two inserted CRs plus the two pre-existing CRLF CRs; none
    // were normalised to LF and no `\\r` text sequence appeared.
    expect(after.filter((b) => b === 0x0d).length).toBe(4);
    expect(after.includes(Buffer.from("\\r"))).toBe(false);
  });

  test("literal newline in replacement is preserved byte-for-byte on disk", async () => {
    const file = join(tmpProj, "newline-replacement.txt");
    const original = "keep\nfirst MATCH second\nthird MATCH fourth\n";
    const expected = "keep\nfirst a\nb second\nthird a\nb fourth\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "MATCH", replacement: "a\nb", roots: [file] });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    // Two original LFs plus the one in each of the two replacements; no
    // `\\n` text sequence and no CR introduced.
    expect(after.filter((b) => b === 0x0a).length).toBe(5);
    expect(after.includes(Buffer.from("\\n"))).toBe(false);
    expect(after.includes(0x0d)).toBe(false);
  });

  test("literal newline in replacement is emitted unchanged by applyRegex", () => {
    const { updated, count } = applyRegex("x MARK y\nMARK\n", /MARK/g, "\n", 100);
    expect(count).toBe(2);
    expect(updated).toBe("x \n y\n\n\n");
    expect(updated.includes("\\n")).toBe(false);
  });

  test("literal tab in replacement is written as a real tab to disk", async () => {
    const file = join(tmpProj, "tab-replacement.txt");
    const original = "colA	colB\nfirst MATCH second\nthird MATCH fourth\n";
    const expected = "colA	colB\nfirst 	 second\nthird 	 fourth\n";
    await writeFile(file, original);

    const args = { pattern: "MATCH", replacement: "	", roots: [file] };

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // The file must contain real tab characters — not the two-char sequence "\t"
    expect((await readFile(file, "utf-8")).includes("	")).toBe(true);
  });

  test("tab replacement (written as \\t in source) puts exactly one 0x09 byte per match and no backslash-t", async () => {
    const file = join(tmpProj, "tab-bytes.txt");
    await writeFile(file, "a=MATCH\nb=MATCH;MATCH\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "MATCH", replacement: "\t", roots: [file] });
    expect(result.text).toContain("1 file, 3 replacements");

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from("a=\t\nb=\t;\t\n", "utf-8"));
    expect(after.filter((b) => b === 0x09).length).toBe(3);
    expect(after.includes(Buffer.from("\\t"))).toBe(false);
  });

  test("literal replacement containing Unicode lands byte-for-byte, without normalization", async () => {
    const file = join(tmpProj, "unicode-replacement.txt");
    // The replacement mixes a decomposed accent (e + U+0301), a ZWJ emoji
    // sequence, RTL text, a non-BMP code point and CJK. It must land
    // verbatim: NFC normalization would fuse each e+◌́ into a precomposed
    // é (U+00E9), and a surrogate-splitting writer would strand halves of
    // 🧑‍💻 / 🧊 as U+FFFD.
    const replacement = "e\u0301 🧑‍💻 مرحبا 🧊 完了";
    const original = "keep MARK café\nMARK! e\u0301 tail\nlast MARK";
    const expected = `keep ${replacement} café\n${replacement}! e\u0301 tail\nlast ${replacement}`;
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement, roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    // The replacement appears exactly, once per match. Its decomposed
    // e+◌́ was never fused to é — the only precomposed é on disk is the
    // one already inside "café" — and no U+FFFD leaked in from a split
    // surrogate pair.
    const text = after.toString("utf-8");
    expect(text.split(replacement).length - 1).toBe(3);
    expect((text.match(/\u00E9/g) ?? []).length).toBe(1);
    expect(text).not.toContain("\uFFFD");

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });


  test("literal `\\$` before a digit does not match a file lacking dollar signs", async () => {
    const file = join(tmpProj, "no-dollar.txt");
    const original = "price 5\nprice 10\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "\\$(\\d+)", replacement: "USD$1", roots: [file] });
    expect(result.text).toContain("0 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);
  });

  test("applies captures up to the per-file cap and leaves the next match intact", async () => {
    const file = join(tmpProj, "names.txt");
    await writeFile(file, "Ada Lovelace; Grace Hopper; Katherine Johnson\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "(\\w+) (\\w+)",
      replacement: "$2, $1",
      maxMatchesPerFile: 2,
    });

    expect(text).toContain("1 file, 2 replacements");
    expect(text).toContain("cap hit");
    expect(await readFile(file, "utf-8")).toBe(
      "Lovelace, Ada; Hopper, Grace; Katherine Johnson\n",
    );
  });

  test("reorders captured text for each match while preserving surrounding content", async () => {
    const file = join(tmpProj, "dates.txt");
    await writeFile(file, "From 2024-03-17 to 2025-12-04; unchanged\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "(\\d{4})-(\\d{2})-(\\d{2})",
      replacement: "$3/$2/$1",
    });

    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "From 17/03/2024 to 04/12/2025; unchanged\n",
    );
  });

  test("named groups reorder captured text across files; unmatched optional group becomes empty", async () => {
    const a = join(tmpProj, "a.txt");
    const b = join(tmpProj, "b.txt");
    await writeFile(a, "key=alpha value=1; key=beta value=22\n");
    await writeFile(b, "key=gamma value=3 key=delta\n");

    const args = {
      pattern: "key=(?<k>[a-z]+)( value=(?<v>\\d+))?",
      replacement: "<$<v>|$<k>>",
    };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("2 files, 4 replacements");
    expect(await readFile(a, "utf-8")).toBe("key=alpha value=1; key=beta value=22\n");

    await ashlrSearchReplaceRegex(args);
    expect(await readFile(a, "utf-8")).toBe("<1|alpha>; <22|beta>\n");
    // `key=delta` has no value group: $<v> expands to "" and $<k> still resolves.
    expect(await readFile(b, "utf-8")).toBe("<3|gamma> <|delta>\n");
  });

  test("$1 and $2 in replacement resolve correctly", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const p = join(src, "x.ts");
    await writeFile(p, "const age_of_user = 30;\nconst name_of_thing = 'y';\n");

    await ashlrSearchReplaceRegex({
      pattern: "(\\w+)_of_(\\w+)",
      replacement: "$2$1",
    });

    const after = await readFile(p, "utf-8");
    expect(after).toContain("const userage");
    expect(after).toContain("const thingname");
  });

  test("$& (whole match) works", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const p = join(src, "y.ts");
    await writeFile(p, "TODO: fix\nTODO: refactor\n");

    await ashlrSearchReplaceRegex({
      pattern: "TODO",
      replacement: "[$&]",
    });
    const after = await readFile(p, "utf-8");
    expect(after).toBe("[TODO]: fix\n[TODO]: refactor\n");
  });

  test("wraps TODO markers on separate lines and preserves intervening text", async () => {
    const file = join(tmpProj, "separate-todos.txt");
    const original = "Header café\r\nTODO: first\r\nKeep this line\n\nTODO: second\nFooter";
    const expected = "Header café\r\n[TODO]: first\r\nKeep this line\n\n[TODO]: second\nFooter";
    await writeFile(file, original);

    const args = { pattern: "TODO", replacement: "[$&]", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(dryRun.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(dryRun.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("wraps TODO markers on nonadjacent lines and preserves the intervening line exactly", async () => {
    const file = join(tmpProj, "nonadjacent-todos.txt");
    // The intervening line is a near-miss minefield — lowercase "todo",
    // mixed-case "Todo", and look-alikes "TOOD"/"TOD" — none containing
    // the literal "TODO", so it must survive byte-for-byte while the two
    // real markers on either side are wrapped.
    const intervening = "todo Todo TOOD TOD keep café";
    const original = `TODO: first\n${intervening}\nTODO: second\n`;
    const expected = `[TODO]: first\n${intervening}\n[TODO]: second\n`;
    await writeFile(file, original);

    const args = { pattern: "TODO", replacement: "[$&]", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Assert each line individually so a mangled middle line can't hide
    // inside a whole-file comparison.
    const lines = after.split("\n");
    expect(lines[0]).toBe("[TODO]: first");
    expect(lines[1]).toBe(intervening);
    expect(lines[2]).toBe("[TODO]: second");
  });

  test("tool replaces TODO items on separate lines without changing unrelated lines", async () => {
    const file = join(tmpProj, "todo-items.txt");
    const original = Buffer.from(
      "Header café\r\nTODO: first\r\nKeep this line\nTODO: second\nTODO? untouched\nTODO: third\nFooter",
      "utf-8",
    );
    const expected = Buffer.from(
      "Header café\r\nDONE: first\r\nKeep this line\nDONE: second\nTODO? untouched\nDONE: third\nFooter",
      "utf-8",
    );
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "TODO: ([a-z]+)", replacement: "DONE: $1", roots: [file] };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(original);

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(expected);
  });

  test("wraps every TODO on one line while preserving surrounding text", async () => {
    const file = join(tmpProj, "todos.txt");
    const original = "Before TODO: fix; TODOTODO: refactor after café\r\nuntouched\n";
    const expected = "Before [TODO]: fix; [TODO][TODO]: refactor after café\r\nuntouched\n";
    await writeFile(file, original);

    const args = { pattern: "TODO", replacement: "[$&]", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("wraps a TODO directly between Unicode text without changing its bytes", async () => {
    const file = join(tmpProj, "unicode-todo.txt");
    const original = "\uFEFFé e\u0301 🧑‍💻TODO猫🌍\r\nمرحبا\n";
    const expected = "\uFEFFé e\u0301 🧑‍💻[TODO]猫🌍\r\nمرحبا\n";
    await writeFile(file, original);

    const args = { pattern: "TODO", replacement: "[$&]", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(dryRun.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(dryRun.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.originalBytes).toBe(dryRun.originalBytes);
    expect(result.newBytes).toBe(dryRun.newBytes);
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("tool replaces two adjacent TODOs and preserves their surrounding characters", async () => {
    const file = join(tmpProj, "adjacent-todos.txt");
    const original = Buffer.from("é<TODOTODO>猫\r\n", "utf-8");
    const expected = Buffer.from("é<[TODO][TODO]>猫\r\n", "utf-8");
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "TODO", replacement: "[$&]", roots: [file] };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(original);

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(expected);
  });

  test("the documented TODO example produces its expected output", async () => {
    const doc = await readFile(join(ORIGINAL_CWD, "docs/regex-replacement-example.md"), "utf-8");
    const blocks = [...doc.matchAll(/```(text|json)\n([\s\S]*?)```/g)];
    expect(blocks.map((block) => block[1])).toEqual(["text", "json", "text"]);

    const input = blocks[0]![2]!;
    const args = JSON.parse(blocks[1]![2]!) as { pattern: string; replacement: string };
    const expected = blocks[2]![2]!;
    expect(input).toBe("TODO: fix\nTODO: refactor\n");
    expect(args).toEqual({ pattern: "TODO", replacement: "[$&]" });
    expect(expected).toBe("[TODO]: fix\n[TODO]: refactor\n");

    const file = join(tmpProj, "todo.txt");
    await writeFile(file, input);
    const result = await ashlrSearchReplaceRegex({ ...args, roots: [file] });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · flags", () => {
  test("i flag matches case-insensitively", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const p = join(src, "z.ts");
    await writeFile(p, "Foo FOO foo\n");

    await ashlrSearchReplaceRegex({
      pattern: "foo",
      replacement: "BAR",
      flags: "i",
    });
    const after = await readFile(p, "utf-8");
    expect(after).toBe("BAR BAR BAR\n");
  });

  test("without the i flag, a lowercase pattern replaces only lowercase matches", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const file = join(src, "case.ts");
    const upperOnly = join(src, "upper.ts");
    // "foo" is the intended match; "Foo"/"FOO" beside it are the
    // look-alikes a case-insensitive pattern would also rewrite — their
    // survival byte-for-byte proves matching is case-sensitive by
    // default. The second file holds only uppercase occurrences, so rg
    // (run without --ignore-case) never surfaces it as a candidate and
    // it must stay untouched.
    const original = "FOO foo Foo foo FOO café\nkeep Foo here\n";
    const expected = "FOO bar Foo bar FOO café\nkeep Foo here\n";
    const upperOriginal = Buffer.from("FOO Foo FOo\r\n", "utf-8");
    await writeFile(file, original);
    await writeFile(upperOnly, upperOriginal);

    const args = { pattern: "foo", replacement: "bar" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(upperOnly)).toEqual(upperOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(upperOnly)).toEqual(upperOriginal);

    // Assert each occurrence individually so a mangled uppercase
    // neighbor can't hide inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("FOO bar Foo bar FOO café");
    expect(lines[1]).toBe("keep Foo here");
  });

  test("tool: case-sensitive literal replaces the exact-case occurrence and leaves differently cased ones unchanged", async () => {
    const file = join(tmpProj, "literal-case.txt");
    const otherCaseOnly = join(tmpProj, "literal-case-other.txt");
    // "Token" is a plain literal (no regex metacharacters). The lower,
    // upper, and mixed-case spellings beside it must survive untouched,
    // and a file holding only those spellings must never be rewritten.
    const original = "Token token TOKEN tOKEN Token café\r\n";
    const expected = "Secret token TOKEN tOKEN Secret café\r\n";
    const otherOriginal = Buffer.from("token TOKEN tOKEN\n", "utf-8");
    await writeFile(file, original);
    await writeFile(otherCaseOnly, otherOriginal);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "Token", replacement: "Secret" };

    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(otherCaseOnly)).toEqual(otherOriginal);
  });

  test("a case-sensitive literal replaces only exact-case occurrences via the direct call", async () => {
    const file = join(tmpProj, "literal-direct-case.txt");
    const offCaseOnly = join(tmpProj, "literal-direct-case-off.txt");
    // "DoIt" is a plain literal (no regex metacharacters) whose own
    // spelling mixes cases. The exact-case occurrences — including the
    // second half of the fused "doItDoIt" token — are rewritten while
    // every other casing stays byte-identical, and the second file,
    // holding only off-case spellings, never becomes a candidate.
    const original = "DoIt doit DOIT Doit doIt DoIt café\r\ntail doItDoIt end\n";
    const expected = "Done doit DOIT Doit doIt Done café\r\ntail doItDone end\n";
    const offOriginal = Buffer.from("doit DOIT Doit doIt\r\n", "utf-8");
    await writeFile(file, original);
    await writeFile(offCaseOnly, offOriginal);

    const args = { pattern: "DoIt", replacement: "Done" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(offCaseOnly)).toEqual(offOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(offCaseOnly)).toEqual(offOriginal);

    // The pure in-memory transform sees the same case-sensitive split:
    // only the three exact-case occurrences move.
    const { updated, count } = applyRegex(original, /DoIt/g, "Done", 100);
    expect(count).toBe(3);
    expect(updated).toBe(expected);
  });

  test("m flag makes ^ match per-line", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const p = join(src, "m.ts");
    await writeFile(p, "// a\n// b\n// c\n");

    await ashlrSearchReplaceRegex({
      pattern: "^// ",
      replacement: "# ",
      flags: "m",
    });
    const after = await readFile(p, "utf-8");
    expect(after).toBe("# a\n# b\n# c\n");
  });

  test("g flag is implicit — global replace always", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const p = join(src, "g.ts");
    await writeFile(p, "a a a a a\n");

    await ashlrSearchReplaceRegex({
      pattern: "a",
      replacement: "b",
      // No flags — g should still apply.
    });
    const after = await readFile(p, "utf-8");
    expect(after).toBe("b b b b b\n");
  });

  test("unsupported flag is refused", async () => {
    await expect(
      ashlrSearchReplaceRegex({
        pattern: "a",
        replacement: "b",
        flags: "y",
      }),
    ).rejects.toThrow(/unsupported flag/);
  });
});

// ---------------------------------------------------------------------------
// maxFiles cap
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · maxFiles cap", () => {
  test("over-limit candidate set is truncated and warned", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    // Create 250 files, each with a match.
    for (let i = 0; i < 250; i++) {
      await writeFile(join(src, `f${i}.ts`), "tokenX\n");
    }

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "tokenX",
      replacement: "tokenY",
      maxFiles: 100,
      dryRun: true,
    });

    // Exactly 100 candidates should have been scanned.
    expect(text).toContain("100 files");
    expect(text).toContain("more than 100 candidates");
  });
});

// ---------------------------------------------------------------------------
// maxMatchesPerFile cap
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · maxMatchesPerFile cap", () => {
  test("replaces only the selected FIXME without changing adjacent TODO text", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const file = join(src, "markers.ts");
    await writeFile(file, "// TODO: keep this; FIXME: selected\n// FIXME: leave this too\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "FIXME",
      replacement: "FIXED",
      maxMatchesPerFile: 1,
    });

    expect(text).toContain("1 replacement");
    expect(await readFile(file, "utf-8")).toBe(
      "// TODO: keep this; FIXED: selected\n// FIXME: leave this too\n",
    );
  });

  test("file with 500 matches + cap=100 → only first 100 replaced, flagged", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const big = join(src, "big.ts");
    await writeFile(big, "x".repeat(500));

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "x",
      replacement: "Y",
      maxMatchesPerFile: 100,
    });
    expect(text).toContain("cap hit");
    expect(text).toContain("100 replacement");

    const after = await readFile(big, "utf-8");
    // First 100 are uppercase, remaining 400 are unchanged.
    expect(after.slice(0, 100)).toBe("Y".repeat(100));
    expect(after.slice(100)).toBe("x".repeat(400));
  });
});

// ---------------------------------------------------------------------------
// Include glob
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · include glob", () => {
  test("restricts candidates to matching files only", async () => {
    const src = join(tmpProj, "src");
    const test = join(tmpProj, "test");
    await mkdir(src, { recursive: true });
    await mkdir(test, { recursive: true });

    await writeFile(join(src, "a.ts"), "foo\n");
    await writeFile(join(test, "a.ts"), "foo\n");

    await ashlrSearchReplaceRegex({
      pattern: "foo",
      replacement: "bar",
      include: ["src/**/*.ts"],
    });

    expect(await readFile(join(src, "a.ts"), "utf-8")).toBe("bar\n");
    // test/ file is outside the include glob — untouched.
    expect(await readFile(join(test, "a.ts"), "utf-8")).toBe("foo\n");
  });
});

// ---------------------------------------------------------------------------
// Exclude glob
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · exclude glob", () => {
  test("removes matching files from the candidate set", async () => {
    const src = join(tmpProj, "src");
    const vendor = join(tmpProj, "vendor");
    await mkdir(src, { recursive: true });
    await mkdir(vendor, { recursive: true });

    await writeFile(join(src, "a.ts"), "foo\n");
    await writeFile(join(vendor, "dep.ts"), "foo\n");

    await ashlrSearchReplaceRegex({
      pattern: "foo",
      replacement: "bar",
      exclude: ["vendor/**"],
    });

    expect(await readFile(join(src, "a.ts"), "utf-8")).toBe("bar\n");
    // vendor/ file is excluded — untouched.
    expect(await readFile(join(vendor, "dep.ts"), "utf-8")).toBe("foo\n");
  });
});

// ---------------------------------------------------------------------------
// Binary refusal
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · binary refusal", () => {
  test("PNG in roots is skipped and warned", async () => {
    const src = join(tmpProj, "src");
    const assets = join(tmpProj, "assets");
    await mkdir(src, { recursive: true });
    await mkdir(assets, { recursive: true });

    // A .ts file with a matching literal so rg still finds something.
    await writeFile(join(src, "a.ts"), "hero\n");
    // A .png file ALSO containing the text literal (so rg surfaces it as
    // a candidate — our binary guard has to drop it).
    await writeFile(join(assets, "hero.png"), "hero literal text\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "hero",
      replacement: "banner",
    });

    expect(text).toContain("1 file");
    // PNG should be listed in skipped set.
    expect(await readFile(join(assets, "hero.png"), "utf-8")).toBe(
      "hero literal text\n",
    );
    expect(await readFile(join(src, "a.ts"), "utf-8")).toBe("banner\n");
  });

  test("file with NUL byte in first 512 bytes is skipped", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    // No extension the binary set would catch, but a NUL byte in header.
    const binFile = join(src, "weird.dat");
    const buf = Buffer.concat([
      Buffer.from("hero "),
      Buffer.from([0x00]),
      Buffer.from(" hero more hero\n"),
    ]);
    await writeFile(binFile, buf);
    // Also a plain .ts with a match.
    await writeFile(join(src, "a.ts"), "hero\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "hero",
      replacement: "banner",
      // Include both by default (no include glob). NUL-sniff should drop weird.dat.
    });

    expect(text).toContain("1 file");
    // weird.dat untouched
    const after = await readFile(binFile);
    expect(after.equals(buf)).toBe(true);
    // a.ts rewritten
    expect(await readFile(join(src, "a.ts"), "utf-8")).toBe("banner\n");
  });
});

// ---------------------------------------------------------------------------
// Project-root default
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · default root", () => {
  test("omitted roots use CLAUDE_PROJECT_DIR when cwd is a plugin cache path", async () => {
    const pluginRoot = join(tmpProj, ".claude", "plugins", "cache", "ashlr-marketplace", "ashlr", "1.29.0");
    const projectRoot = join(tmpProj, "workspace");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.ts"), "foo\n");
    await writeFile(join(projectRoot, "app.ts"), "foo\n");

    process.chdir(pluginRoot);
    process.env.CLAUDE_PROJECT_DIR = projectRoot;

    await ashlrSearchReplaceRegex({
      pattern: "foo",
      replacement: "bar",
    });

    expect(await readFile(join(projectRoot, "app.ts"), "utf-8")).toBe("bar\n");
    expect(await readFile(join(pluginRoot, "plugin.ts"), "utf-8")).toBe("foo\n");
  });
});

// ---------------------------------------------------------------------------
// File size cap
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · file size cap", () => {
  test("files over 50 MB are skipped before reading or rewriting", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const huge = join(src, "huge.txt");
    const small = join(src, "small.txt");
    await writeFile(huge, "needle\n" + "x".repeat(50 * 1024 * 1024));
    await writeFile(small, "needle\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "needle",
      replacement: "replaced",
    });

    expect(text).toContain("1 file");
    expect(text).toContain("over the 52428800 byte safety cap");
    expect((await readFile(huge, "utf-8")).startsWith("needle\n")).toBe(true);
    expect(await readFile(small, "utf-8")).toBe("replaced\n");
  });
});

// ---------------------------------------------------------------------------
// Outside-cwd refusal
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · outside-cwd refusal", () => {
  test("roots pointing outside cwd is refused", async () => {
    await expect(
      ashlrSearchReplaceRegex({
        pattern: "foo",
        replacement: "bar",
        roots: ["/etc"],
      }),
    ).rejects.toThrow(/refused path outside working directory/);
  });
});

// ---------------------------------------------------------------------------
// Invalid regex refusal
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · invalid regex refusal", () => {
  test("returns an error and leaves the target file unchanged", async () => {
    const file = join(tmpProj, "target.txt");
    const original = Buffer.from("foo\r\nfoo\n", "utf-8");
    await writeFile(file, original);

    const args = { pattern: "(", replacement: "bar" };
    const result = await planSearchReplaceRegex(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid regex/i);
    await expect(ashlrSearchReplaceRegex(args)).rejects.toThrow(/invalid regex/i);
    expect(await readFile(file)).toEqual(original);
  });

  test("tool reports the syntax problem and preserves file bytes in apply and dry run", async () => {
    const file = join(tmpProj, "target.txt");
    const original = Buffer.from("\uFEFFfoo\r\nfoo\n", "utf-8");
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dryRun of [false, true]) {
      const result = await tool!.handler(
        { pattern: "(", replacement: "bar", roots: [file], dryRun },
        { env: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("invalid regex");
      expect(result.content[0]?.text).toMatch(/missing \)/i);
      expect(await readFile(file)).toEqual(original);
    }
  });

  test("a JS-valid pattern ripgrep cannot scan is refused, leaving the file untouched", async () => {
    const file = join(tmpProj, "lookbehind.txt");
    const original = Buffer.from("ab cb café\n", "utf-8");
    await writeFile(file, original);

    // `(?<=a)b` compiles in JS, but Rust's regex engine has no look-around —
    // rg exits 2 and the scan must surface as a refusal, never as a silent
    // "0 files, 0 replacements" or a partially-scanned rewrite.
    const args = { pattern: "(?<=a)b", replacement: "B", roots: [file] };
    const result = await planSearchReplaceRegex(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ripgrep failed to scan");
    await expect(ashlrSearchReplaceRegex(args)).rejects.toThrow(/ripgrep failed/);
    expect(await readFile(file)).toEqual(original);

    // The tool handler reports the same refusal on the JSON args path.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.content[0]?.text).toContain("ripgrep failed to scan");
    expect(await readFile(file)).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Zero-width pattern refusal
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · zero-width refusal", () => {
  test("pattern that matches empty string is refused", async () => {
    await expect(
      ashlrSearchReplaceRegex({
        pattern: ".*",
        replacement: "X",
      }),
    ).rejects.toThrow(/zero-width/);
  });

  test("pattern `^` (zero-width anchor alone) is refused", async () => {
    await expect(
      ashlrSearchReplaceRegex({
        pattern: "^",
        replacement: "X",
        flags: "m",
      }),
    ).rejects.toThrow(/zero-width/);
  });

  test("a bare `|` alternation is refused as zero-width, leaving pipes untouched", async () => {
    const file = join(tmpProj, "unescaped-pipe.txt");
    // An unescaped `|` is an empty alternation — it matches at every
    // position, so a literal-pipe search MUST be written `\|` or `[|]`.
    // The tool has to refuse rather than replace at every offset; the
    // file's real pipes prove nothing was rewritten in the attempt.
    const original = Buffer.from("a|b keep café | end|\n", "utf-8");
    await writeFile(file, original);

    await expect(
      ashlrSearchReplaceRegex({ pattern: "|", replacement: "X" }),
    ).rejects.toThrow(/zero-width/);
    expect(await readFile(file)).toEqual(original);
  });

  test("empty pattern is refused", async () => {
    await expect(
      ashlrSearchReplaceRegex({
        pattern: "",
        replacement: "X",
      }),
    ).rejects.toThrow(/'pattern' is required/);
  });
});

// ---------------------------------------------------------------------------
// Plan surface (internal)
// ---------------------------------------------------------------------------

describe("planSearchReplaceRegex · plan shape", () => {
  test("returns per-file match counts and byte sizes", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "a.ts"), "foo foo\n");

    const res = await planSearchReplaceRegex({
      pattern: "foo",
      replacement: "barbaz",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.plan.files.length).toBe(1);
    const fp = res.plan.files[0]!;
    expect(fp.matches).toBe(2);
    expect(fp.capped).toBe(false);
    expect(fp.originalBytes).toBe(Buffer.byteLength("foo foo\n", "utf-8"));
    expect(fp.newBytes).toBe(Buffer.byteLength("barbaz barbaz\n", "utf-8"));
  });

  test("returns ok with an empty plan for an absent literal and writes nothing", async () => {
    const file = join(tmpProj, "contents.txt");
    const original = Buffer.from("café\r\nnothing to rewrite\n", "utf-8");
    await writeFile(file, original);

    const res = await planSearchReplaceRegex({
      pattern: "absent_literal",
      replacement: "x",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.files).toEqual([]);
    expect(res.plan.skipped).toBe(0);
    expect(res.plan.warnings).toEqual([]);
    expect(await readFile(file)).toEqual(original);
  });

  test("plans a literal replacement containing $& with each file's own byte delta", async () => {
    const a = join(tmpProj, "widths-a.txt");
    const b = join(tmpProj, "widths-b.txt");
    // `$$&` shrinks every match to the two-byte literal `$&`, so each
    // file's newBytes depends on how wide ITS matches were: a drops
    // (3-2)+(4-2)+(5-2)=6 bytes across three matches, b drops 3-2=1
    // byte across one. The planned sizes — not just the match counts —
    // must reflect the literal landing verbatim at every site.
    const originalA = "n=7 n=88 n=999\n";
    const originalB = "keep n=1\r\nn=x n=\n";
    await writeFile(a, originalA);
    await writeFile(b, originalB);

    const res = await planSearchReplaceRegex({
      pattern: "n=\\d+",
      replacement: "$$&",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const fa = res.plan.files.find((f) => f.path === a);
    const fb = res.plan.files.find((f) => f.path === b);
    expect(fa?.matches).toBe(3);
    expect(fb?.matches).toBe(1);
    expect(fa?.originalBytes).toBe(Buffer.byteLength(originalA, "utf-8"));
    expect(fb?.originalBytes).toBe(Buffer.byteLength(originalB, "utf-8"));
    expect(fa?.newBytes).toBe(Buffer.byteLength("$& $& $&\n", "utf-8"));
    expect(fb?.newBytes).toBe(Buffer.byteLength("keep $&\r\nn=x n=\n", "utf-8"));

    // Planning never writes.
    expect(await readFile(a, "utf-8")).toBe(originalA);
    expect(await readFile(b, "utf-8")).toBe(originalB);
  });
});

// ---------------------------------------------------------------------------
// applyRegex unit (pure — no filesystem)
// ---------------------------------------------------------------------------

describe("applyRegex · pure transformation", () => {
  test("returns the original text and zero replacements for an absent pattern", () => {
    const original = "café\r\nleave this alone\n";
    const result = applyRegex(original, /replace me/g, "done", 100);

    expect(result).toEqual({ updated: original, count: 0, capped: false });
  });

  test("does not report a cap hit when all matches fit exactly", () => {
    const { updated, count, capped } = applyRegex("a a", /a/g, "b", 2);
    expect(updated).toBe("b b");
    expect(count).toBe(2);
    expect(capped).toBe(false);
  });

  test("respects the per-call cap", () => {
    const re = /a/g;
    const { updated, count, capped } = applyRegex("aaaaa", re, "B", 3);
    expect(count).toBe(3);
    expect(capped).toBe(true);
    expect(updated).toBe("BBBaa");
  });

  test("handles capture groups", () => {
    const re = /(\w+)=(\d+)/g;
    const { updated, count } = applyRegex("x=1 y=2", re, "$1:$2", 100);
    expect(count).toBe(2);
    expect(updated).toBe("x:1 y:2");
  });

  test("escaped $$& in a replacement emits the two characters $& while a bare $& expands", () => {
    // `$$&` resolves to the literal text `$&`; the unescaped `$&` in the
    // same replacement still resolves to the match substring.
    const { updated, count } = applyRegex("a MARK b\n", /MARK/g, "$$&=$&", 100);
    expect(count).toBe(1);
    expect(updated).toBe("a $&=MARK b\n");
  });

  test("lone escaped $$& replaces every match with the literal text $& and never the match", () => {
    const { updated, count } = applyRegex("a MARK b MARK c\n", /MARK/g, "$$&", 100);
    expect(count).toBe(2);
    expect(updated).toBe("a $& b $& c\n");
    expect(updated.includes("MARK")).toBe(false);
  });

  test("$$$& emits a literal dollar followed by the expanded match", () => {
    // `$$` -> `$`, then bare `$&` -> match.
    const { updated, count } = applyRegex("a MARK b\n", /MARK/g, "$$$&", 100);
    expect(count).toBe(1);
    expect(updated).toBe("a $MARK b\n");
  });

  test("escaped $$' in a replacement emits the two characters $' while a bare $' collapses", () => {
    // `$$'` resolves to the literal text `$'`; the trailing bare `$'` in
    // the same replacement still resolves to the (empty) text after the
    // match — never to the remaining input.
    const { updated, count } = applyRegex("a MARK b\n", /MARK/g, "$$'=$&$'", 100);
    expect(count).toBe(1);
    expect(updated).toBe("a $'=MARK b\n");
  });

  test("escaped $$$$ in a replacement emits the two characters $$ while a bare $& expands", () => {
    // `$$$$` is two `$$` escapes — each yields one literal `$`, so the
    // two-character text `$$` lands verbatim. The bare `$&` in the same
    // replacement still resolves to the match substring.
    const { updated, count } = applyRegex("a MARK b\n", /MARK/g, "$$$$=$&", 100);
    expect(count).toBe(1);
    expect(updated).toBe("a $$=MARK b\n");
  });

  test("scopes $' expansion to the match substring — the remaining input is never inserted", () => {
    // Against the whole source, "a MARK b MARK c\n".replace(/MARK/g, "x $' y")
    // would emit "a x  b MARK c\n y b x  c\n y c\n" — each match dragging the
    // rest of the input behind it. The per-match walk confines the token to
    // the match substring itself, where the text after the match is empty.
    const { updated, count, capped } = applyRegex("a MARK b MARK c\n", /MARK/g, "x $' y", 100);
    expect(count).toBe(2);
    expect(capped).toBe(false);
    expect(updated).toBe("a x  y b x  y c\n");
  });

  test("literal backslash in replacement is emitted unchanged by applyRegex", () => {
    // `\n`, `\t`, `\1`, `\\` and a trailing `\` are not escapes or group
    // references; only `$` tokens are special in a JS replacement string.
    const replacement = "C:\\dir\\new\\t\\1\\\\x\\";
    const { updated, count, capped } = applyRegex("a MARK b MARK c\n", /MARK/g, replacement, 100);
    expect(count).toBe(2);
    expect(capped).toBe(false);
    expect(updated).toBe(`a ${replacement} b ${replacement} c\n`);
    expect(updated.split("\\").length - 1).toBe(2 * 7);
    expect(updated).not.toContain("\t");
  });

  test("literal carriage return in replacement is emitted unchanged by applyRegex", () => {
    const { updated, count } = applyRegex("x MARK y\r\nMARK\r\n", /MARK/g, "\r", 100);
    expect(count).toBe(2);
    expect(updated).toBe("x \r y\r\n\r\r\n");
    expect(updated.includes("\\r")).toBe(false);
  });

  test("literal tab in replacement lands as a real tab after applyRegex", () => {
    // A tab character in the replacement string is emitted as a real tab,
    // never as the two characters backslash-t.
    const { updated, count } = applyRegex("x MARK y", /MARK/g, "	", 100);
    expect(count).toBe(1);
    expect(updated).toBe("x 	 y");
    expect(updated.includes("	")).toBe(true);
  });

  test("tab in a replacement is retained exactly through the tool handler, beside capture groups", async () => {
    const file = join(tmpProj, "tab-handler.txt");
    const original = "k1=v1\nk2=v2\nplain line\n";
    await writeFile(file, original);
    const args = { pattern: "(\\w+)=(\\w+)", replacement: "$1\t$2\t", roots: [file] };

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(await readFile(file, "utf-8")).toBe(original);

    await tool!.handler(args, { env: {} });
    const after = await readFile(file);
    expect(after).toEqual(Buffer.from("k1\tv1\t\nk2\tv2\t\nplain line\n", "utf-8"));
    expect(after.filter((b) => b === 0x09).length).toBe(4);
    expect(after.includes(Buffer.from("\\t"))).toBe(false);
  });

  test("literal Unicode replacement is emitted unchanged by applyRegex", () => {
    // A decomposed accent (e + U+0301), a ZWJ sequence, a non-BMP code
    // point and CJK pass through verbatim — no normalization to é, no
    // split surrogates.
    const replacement = "e\u0301 🧑‍💻 🧊 完了";
    const { updated, count, capped } = applyRegex("a MARK b MARK c\n", /MARK/g, replacement, 100);
    expect(count).toBe(2);
    expect(capped).toBe(false);
    expect(updated).toBe(`a ${replacement} b ${replacement} c\n`);
    expect(updated.split(replacement).length - 1).toBe(2);
    expect(updated).not.toContain("\u00E9");
    expect(updated).not.toContain("\uFFFD");
  });

  test("empty replacement deletes each match and keeps the text between them", () => {
    const { updated, count, capped } = applyRegex("a X b X c\n", /X/g, "", 100);
    expect(count).toBe(2);
    expect(capped).toBe(false);
    expect(updated).toBe("a  b  c\n");
  });
});
