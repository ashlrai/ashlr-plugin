/**
 * search-replace-regex.test.ts — v1.20 multi-file regex search/replace.
 *
 * Covers:
 *   - dryRun: lists planned edits across 3 files, no writes
 *   - apply: same setup → files actually changed with correct counts
 *   - Unicode replacement preserves adjacent Unicode text
 *   - u-flag matching never splits a surrogate pair; the Unicode
 *     replacement and an rg-only candidate file stay byte-identical
 *   - empty replacement removes matches while preserving surrounding
 *     text — via the direct call, and through the tool handler where
 *     `""` must satisfy the required-`replacement` check
 *   - escaped dollar signs remain literal in replacements
 *   - backslashes in a literal replacement are preserved verbatim
 *   - escaped `\$` in the pattern matches a literal dollar sign, not an
 *     end anchor
 *   - escaped `\+` in the pattern matches a literal plus sign, not a
 *     one-or-more quantifier, leaving quantifier look-alikes unchanged
 *   - nonmatching files remain unchanged alongside matching files
 *   - escaped punctuation in the pattern matches literally, leaving
 *     look-alike neighbors unchanged
 *   - a bare `\.` replaces only literal periods; any other character
 *     (letters, digits, punctuation, Unicode) and dot-free files stay
 *     byte-identical, via the direct call and the tool handler
 *   - no-match tool calls report zero replacements and preserve file bytes
 *   - multiple matches on one line: all replaced, unrelated text unchanged
 *   - a literal repeated nonadjacently (same line and across lines) has
 *     every occurrence replaced while the intervening text stays identical
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
 *   - flags: i (case-insensitive), m (multiline anchors)
 *   - maxFiles cap: over-limit candidate set reports truncation warning
 *   - maxMatchesPerFile cap: per-file cap leaves extras in place
 *   - include glob restricts candidates
 *   - exclude glob removes candidates
 *   - binary refusal: PNG in roots is skipped
 *   - outside-cwd refusal on roots
 *   - invalid regex refusal without modifying the target
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

  test("inserts a literal $1 via $$1 even when the pattern has a capture group", async () => {
    const file = join(tmpProj, "literal-dollar-one.txt");
    await writeFile(file, "name=alice\nname=bob\n");

    const result = await ashlrSearchReplaceRegex({ pattern: "name=(\\w+)", replacement: "name=$$1", flags: "" });
    expect(result.text).toContain("1 file, 2 replacements");
    // Exactly the two characters "$1", not the captured group.
    expect(await readFile(file, "utf-8")).toBe("name=$1\nname=$1\n");
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
});
