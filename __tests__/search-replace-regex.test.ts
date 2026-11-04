/**
 * search-replace-regex.test.ts — v1.20 multi-file regex search/replace.
 *
 * Covers:
 *   - dryRun: lists planned edits across 3 files, no writes
 *   - apply: same setup → files actually changed with correct counts
 *   - Unicode replacement preserves adjacent Unicode text
 *   - an ASCII literal touching Unicode characters is replaced while the
 *     adjacent Unicode stays byte-identical
 *   - a literal Unicode search matches exact code points without normalization
 *   - u-flag matching never splits a surrogate pair; the Unicode
 *     replacement and an rg-only candidate file stay byte-identical
 *   - empty replacement removes matches while preserving surrounding
 *     text — via the direct call (regex, plain-literal, escaped-literal
 *     and Unicode-literal patterns), and through the tool handler where
 *     `""` must satisfy the required-`replacement` check
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
 *   - a literal replacement containing `$1` lands verbatim when the
 *     pattern has no capture group — an out-of-range `$n` is not a
 *     token — via the direct call, the pure applyRegex path and the
 *     tool handler
 *   - a literal replacement containing `$1` lands verbatim beside an
 *     expanding capture-group token — `$$1` emits the identical two
 *     bytes at every match width while a bare `$1` still expands —
 *     via the direct call, the pure applyRegex path and the tool
 *     handler
 *   - backslashes in a literal replacement are preserved verbatim
 *   - a literal tab character in a replacement lands as a real tab on disk
 *   - a literal replacement containing a tab amid ordinary text keeps
 *     the 0x09 byte unchanged — via the direct call, the pure applyRegex
 *     path and the tool handler
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
 *   - a plain literal search replaces every occurrence, including inside a
 *     similar longer string ("cat" in "concat" and "cats"), and the whole
 *     tool output is checked
 *   - a literal search with leading spaces replaces only matches that
 *     include those spaces — the spaces are consumed with the match,
 *     longer runs match on their last two spaces only, adjacent matches
 *     each consume their own leading spaces, and shorter runs, tabs,
 *     NBSPs and a look-alike-only file stay byte-identical, via the
 *     direct call, the pure applyRegex path and the tool handler
 *   - a literal search with a single leading space replaces only the
 *     space-prefixed word; unprefixed and tab-prefixed look-alikes stay
 *   - a literal search with trailing spaces replaces only matches that
 *     include those spaces — the spaces are consumed with the match,
 *     longer runs match on their first two spaces only, adjacent matches
 *     each consume their own trailing spaces, and shorter runs, tabs,
 *     NBSPs and a look-alike-only file stay byte-identical, via the
 *     direct call, the pure applyRegex path and the tool handler
 *   - a literal carriage return in a replacement is written byte-for-byte,
 *     alone and next to existing CRLF line endings, via the direct call,
 *     the pure applyRegex path, and the tool handler (mid-text, beside
 *     capture groups and a CRLF pair, with a no-write dry run)
 *   - a literal newline in a replacement is written as a real LF on disk
 *     and emitted unchanged by applyRegex
 *   - a literal newline replacement lands exactly at each match position
 *     (file start, mid-line, before a CRLF, EOF) via the tool handler,
 *     with a dry run that writes nothing
 *   - escaped `\$` in the pattern matches a literal dollar sign, not an
 *     end anchor; `[$&]` in the replacement wraps each U+0024 match in
 *     brackets, proving the match is exactly one dollar byte — at
 *     offset 0, mid-token, adjacent and at line end — while dollar
 *     look-alikes and dollar-free text stay byte-identical
 *   - a literal dollar-sign search treats `$&`, `$'`, `$1` and `` $` ``
 *     in the searched text as plain data — only each `$` byte is
 *     replaced while the token bodies survive — and the same literal
 *     spelled `\x24` / `\u0024` matches the identical U+0024 set under
 *     the m flag, with dollars before a CRLF and at EOF included
 *   - a literal dollar search beside regex metacharacters — `\$\{NAME\}`,
 *     `\$\(pwd\)`, `\$HOME` and `[$][{(]` — matches only the whole literal;
 *     brace/paren/dollar-free look-alikes and ＄ stay byte-identical, via the
 *     direct call, the pure applyRegex path and the tool handler
 *   - under the m flag a literal `\$` still hits only U+0024 — at offset
 *     0, mid-token, before an LF, before a CRLF and at EOF — while every
 *     dollar-free line end (where a misread end anchor would fire) stays
 *     byte-identical and a dollar-free file in the same roots never
 *     enters the plan, via the direct call, the pure planner and the
 *     pure applyRegex path
 *   - escaped `\^` matches only literal carets (even with the m flag, and
 *     between ordinary text) while caret look-alikes, line starts, and
 *     surrounding bytes stay identical
 *   - a bare `\^` replaces only literal carets at every boundary —
 *     offset 0, mid-token, an adjacent `^^` run, before a CRLF and at
 *     EOF — while caret look-alikes (U+02C6, U+FF3E, U+2227, U+2038,
 *     U+2303, U+02C4), every line start and a caret-free file stay
 *     byte-identical, via the direct call, the pure planner, the pure
 *     applyRegex path and the tool handler
 *   - a literal caret spelled `[\^]`, `\x5e`, `\u005e` or `\u{5e}`
 *     (u flag) replaces only U+005E — caret look-alikes and a caret-free
 *     file stay byte-identical, via the direct call, the pure planner
 *     and the pure applyRegex path
 *   - a bare `\^\^` pair search replaces only consecutive carets —
 *     a `^^^` run yields one pair match plus a leftover `^`; lone
 *     carets, fullwidth `＾＾` and a single-caret-only file stay
 *     byte-identical, via the direct call, the pure applyRegex path
 *     and the tool handler
 *   - a `^` in the replacement is inserted verbatim beside carets
 *     the pattern never touched, via the direct call and applyRegex
 *   - a bare `^` or `^^` (start anchors alone) is refused as
 *     zero-width — a literal-caret search must be written `\^` or
 *     `[\^]` — on the direct call and through the tool handler
 *   - escaped `\+` in the pattern matches a literal plus sign, not a
 *     one-or-more quantifier, leaving quantifier look-alikes unchanged
 *   - a literal plus written as the `[+]` class (or escaped `\+` via the
 *     tool handler) replaces only U+002B — plus look-alikes (U+FF0B,
 *     U+FE62, U+2795, U+00B1) and a plus-free file stay byte-identical
 *   - a literal plus spelled `[+]`, `\x2b`, `\u002b` or `\u{2b}`
 *     (u flag) replaces only U+002B — at offset 0, mid-token, in an
 *     adjacent run, before a CRLF and at EOF — while plus look-alikes
 *     (U+FF0B, U+FE62, U+2795, U+00B1) and a plus-free file stay
 *     byte-identical, via the direct call, the pure planner and the
 *     pure applyRegex path
 *   - a literal `C\+\+` token replaces only the two-plus spelling —
 *     single-C and single-plus look-alikes (C, CC, CCC, C+, Cpp,
 *     lowercase c++, U+FF0B) and a token-free file stay byte-identical,
 *     via the direct call and the tool handler
 *   - a bare `\+\+` pair search replaces only consecutive plus signs —
 *     a `+++` run yields one pair match plus a leftover `+`; lone `+`s,
 *     fullwidth `＋＋` and a single-plus-only file stay byte-identical,
 *     via the direct call, the pure applyRegex path and the tool handler
 *   - a `+` in the replacement is inserted verbatim beside plus signs
 *     the pattern never touched, via the direct call and applyRegex
 *   - a literal asterisk search — `\*` or the `[*]` class — replaces
 *     only ASCII U+002A stars; fullwidth ＊, small ﹡ and ★ look-alikes
 *     and a star-free file stay byte-identical, via the direct call,
 *     the pure applyRegex path and the tool handler
 *   - a literal asterisk spelled `[*]`, `\x2A`, `\u002A` or `\u{2A}`
 *     (u flag) replaces only U+002A — at offset 0, mid-token, in an
 *     adjacent run, before a CRLF and at EOF — while star look-alikes
 *     (U+FF0A, U+FE61, U+2217, U+2042, U+204E, U+2605) and a star-free
 *     file stay byte-identical, via the direct call, the pure planner
 *     and the pure applyRegex path
 *   - a bare `\*\*` pair search replaces only consecutive asterisks —
 *     a `***` run yields one pair match plus a leftover `*`; lone `*`s,
 *     fullwidth `＊＊` and a single-star-only file stay byte-identical,
 *     via the direct call, the pure applyRegex path and the tool handler
 *   - a `*` in the replacement is inserted verbatim beside asterisks
 *     the pattern never touched, via the direct call and applyRegex
 *   - a bare `*` or `**` (a quantifier with nothing to repeat) is
 *     refused as an invalid regex — a literal-asterisk search must be
 *     written `\*` or `[*]` — on the direct call and through the tool
 *     handler
 *   - a literal question mark spelled `[?]`, `\x3f`, `\u003f` or
 *     `\u{3f}` (u flag) replaces only U+003F — at offset 0, mid-token,
 *     in an adjacent run, before a CRLF and at EOF — while mark
 *     look-alikes (U+FF1F, U+2047, U+061F, U+203D, U+00BF, U+2753) and
 *     a mark-free file stay byte-identical, via the direct call, the
 *     pure planner and the pure applyRegex path
 *   - an unescaped `?` is an optional quantifier (`ba?` hits "ba" and
 *     "b", never the `?` byte); only `ba\?` rewrites the literal
 *   - a bare `\?\?` pair search replaces only consecutive question
 *     marks — a `???` run yields one pair match plus a leftover `?`;
 *     lone marks and fullwidth `？？` stay byte-identical, via the
 *     direct call, the pure applyRegex path and the tool handler
 *   - a `?` in the replacement is inserted verbatim beside question
 *     marks the pattern never touched, via the direct call and
 *     applyRegex
 *   - a bare `?` or `??` (a quantifier with nothing to repeat) is
 *     refused as an invalid regex — a literal question-mark search
 *     must be written `\?` or `[?]` — on the direct call and through
 *     the tool handler
 *   - an optional-only pattern like `a?` or `a??` (which also matches
 *     the empty string) is refused as zero-width
 *   - escaped `\(`…`\)` in the pattern matches literal parentheses, not
 *     a capture group — via the direct call and the tool handler
 *   - a bare escaped `\|` replaces only the literal pipe character; bar
 *     look-alikes (U+FF5C, U+2502, U+00A6) and pipe-free files stay
 *     byte-identical
 *   - a literal pipe written as the `[|]` character class replaces only
 *     U+007C — bar look-alikes and a pipe-free file stay byte-identical,
 *     via the direct call and the tool handler
 *   - a literal pipe spelled `\x7c`, `\u007c` or `\u{7c}` (u flag)
 *     replaces only U+007C — bar look-alikes and a pipe-free file stay
 *     byte-identical, via the direct call, the pure planner and the
 *     pure applyRegex path
 *   - a backslash-pipe search (`\\\|`) replaces only the two-character
 *     `\|` text — bare pipes, lone backslashes and bar look-alikes stay
 *     byte-identical
 *   - a bare `|` (empty alternation) is refused as zero-width rather
 *     than matching every position
 *   - a bare `$` or `$$` (end anchors alone) is refused as zero-width —
 *     a literal-dollar search must be written `\$` or `[$]` — on the
 *     direct call and through the tool handler
 *   - a bare `+` (a quantifier with nothing to repeat) is refused as
 *     an invalid regex — a literal-plus search must be written `\+`
 *     or `[+]` — on the direct call and through the tool handler
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
 *   - escaped `\[`…`\]` in the pattern matches a literal bracket pair,
 *     never the single characters the unescaped `[foo]` class reading
 *     would hit — bare class members, half-pairs, different-contents
 *     pairs and a class-members-only file stay byte-identical, via the
 *     direct call, the pure applyRegex path and the tool handler
 *   - a bare `\.` replaces only literal periods; any other character
 *     (letters, digits, punctuation, Unicode) and dot-free files stay
 *     byte-identical, via the direct call and the tool handler
 *   - a literal period finds no match among dot look-alikes (U+2024,
 *     U+FF0E, U+00B7, U+2026) — the dot-free file stays byte-identical
 *   - a literal period written as the `[.]` class — or spelled `\x2E` /
 *     `\u002E` under the s flag, where an unescaped `.` would also
 *     consume newlines — replaces only U+002E at every boundary
 *     (offset 0, mid-token, an adjacent `..` run, before a CRLF and at
 *     EOF); dot look-alikes and ordinary bytes stay identical, via the
 *     direct call, the tool handler and the pure applyRegex path
 *   - a literal ellipsis `\.\.\.` replaces only three-period runs, and a
 *     bare `\.` across several files (domains, decimals) replaces only
 *     real periods while dot-free files stay byte-identical
 *   - a bare `\.\.` pair search replaces only consecutive periods — a
 *     `...` run yields one pair plus a leftover period — while lone
 *     periods, `‥` / `．．` look-alikes and a pair-free file stay
 *     byte-identical, via the direct call, the pure applyRegex path
 *     and the tool handler
 *   - a literal period at a literal's edge — `\.com` leading, `end\.`
 *     trailing — requires the real U+002E; the spellings an unescaped
 *     `.com` / `end.` would have matched stay byte-identical
 *   - a `.` in the replacement is inserted verbatim beside untouched
 *     periods
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
 *   - an escaped literal finds no match in files holding only
 *     regex-reading look-alikes — strings the unescaped pattern would
 *     have matched stay byte-identical and the reported count is zero,
 *     via the direct call, the pure applyRegex path and the tool handler
 *   - a two-line literal with escaped metacharacters is replaced mid-file
 *     and at EOF while wildcard, joined-line, CRLF and swapped-order
 *     look-alikes stay byte-identical
 *   - a literal search spanning LF newlines replaces every three-line
 *     match — mid-file and at EOF — while space-joined, rotated,
 *     wrong-tail and CRLF look-alikes stay byte-identical, via the
 *     direct call, the tool handler and the pure applyRegex path
 *   - a literal search containing a carriage return replaces only the
 *     exact CR-joined match — the bare CR is a different byte sequence
 *     than a CRLF pair, an LF, a space, no separator or the `\r` escape
 *     text, so every look-alike and the look-alike-only file stay
 *     byte-identical, via the direct call and the tool handler
 *   - a bare `\r` search replaces every carriage-return byte —
 *     including the CR inside each CRLF pair, whose LF survives —
 *     while lone LFs and a CR-free file stay byte-identical, via the
 *     direct call, the pure applyRegex path and the tool handler
 *   - multiple matches on one line: all replaced, unrelated text unchanged
 *   - adjacent literal matches are each replaced once, without rescanning
 *     replacement text, including at file boundaries
 *   - a literal repeated nonadjacently (same line and across lines) has
 *     every occurrence replaced while the intervening text stays identical
 *   - a literal repeated five times on a single newline-free line is fully
 *     replaced by shorter, equal and longer replacements, gaps verbatim
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
 *   - an exact-case literal holds its spelling against all seven other
 *     case permutations — standalone, embedded in longer tokens and at
 *     EOF — while the i flag rewrites every spelling of the same
 *     fixture and pulls the off-case-only file into the candidate set
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

  test("a bare literal tab search leaves a space-separated neighbor untouched, in the same line and in another file", async () => {
    // Tab-only pattern: the tab between "name" and "value" is the whole match.
    // The space-separated neighbor on the same line, and a file holding only
    // spaces, stay byte-identical.
    const tabbed = join(tmpProj, "tab-neighbor.tsv");
    const spaced = join(tmpProj, "space-neighbor.txt");
    const spacedBytes = Buffer.from("name value\nname    value\n", "utf-8");
    await writeFile(tabbed, "name\tvalue | name value\n");
    await writeFile(spaced, spacedBytes);

    const args = { pattern: "\t", replacement: "<TAB>", roots: [tabbed, spaced] };
    expect(args.pattern).toHaveLength(1);
    expect(args.pattern.charCodeAt(0)).toBe(9);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(tabbed, "utf-8")).toBe("name\tvalue | name value\n");

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(tabbed, "utf-8")).toBe("name<TAB>value | name value\n");
    expect(await readFile(spaced)).toEqual(spacedBytes);
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
    // The pattern "  indent" starts with two real 0x20 bytes, and the
    // spaces are part of the match — "OUT" lands at column 0, never as
    // "  OUT". Occurrences with fewer leading spaces, a tab, NBSPs or
    // none at all must stay byte-identical, both beside the matches and
    // in a look-alike-only file that never enters the candidate set. A
    // run of three or four spaces matches on its last two only (leftmost
    // semantics), so the spare spaces survive in front of the
    // replacement — proof the match is exactly two spaces wide, not
    // "some leading whitespace plus the word". Two matches sitting
    // back-to-back each consume their own leading spaces.
    const file = join(tmpProj, "leading-spaces.txt");
    const lookalikes = join(tmpProj, "leading-space-lookalikes.txt");
    const lookalikeBytes = Buffer.from(
      "indent\n indent\n\tindent\n\u00a0\u00a0indent\nx indent\n",
      "utf-8",
    );
    const original =
      "  indent one\n" +
      "indent two\n" +
      " indent three\n" +
      "\tindent four\n" +
      "\u00a0\u00a0indent five\n" +
      "x  indent six\n" +
      "   indent seven\n" +
      "    indent eight\n" +
      "  indent  indent nine\n";
    const expected =
      "OUT one\n" +
      "indent two\n" +
      " indent three\n" +
      "\tindent four\n" +
      "\u00a0\u00a0indent five\n" +
      "xOUT six\n" +
      " OUT seven\n" +
      "  OUT eight\n" +
      "OUTOUT nine\n";
    await writeFile(file, original);
    await writeFile(lookalikes, lookalikeBytes);

    const args = { pattern: "  indent", replacement: "OUT" };
    expect(args.pattern.startsWith("  ")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    // Each of the six matches is exactly "  indent" (8 bytes) — the two
    // spaces included — so the file shrinks by 6 × (8 − 3) = 30 bytes.
    expect(result.originalBytes - result.newBytes).toBe(30);
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("OUT one");
    expect(lines[1]).toBe("indent two");
    expect(lines[2]).toBe(" indent three");
    expect(lines[3]).toBe("\tindent four");
    expect(lines[4]).toBe("\u00a0\u00a0indent five");
    expect(lines[5]).toBe("xOUT six");
    expect(lines[6]).toBe(" OUT seven");
    expect(lines[7]).toBe("  OUT eight");
    expect(lines[8]).toBe("OUTOUT nine");

    // The pure applyRegex path consumes the same two spaces per match.
    const pure = applyRegex(original, /  indent/g, "OUT", 100);
    expect(pure.count).toBe(6);
    expect(pure.updated).toBe(expected);

    // Same through the tool handler (JSON args path) — the leading
    // spaces must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // A second pass finds nothing left to replace.
    const second = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(second.isError).not.toBe(true);
    expect(second.content[0]?.text).toContain("0 files, 0 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a literal search with trailing spaces replaces only matches that include those spaces", async () => {
    // The pattern "pad  " ends with two real 0x20 bytes, and the
    // spaces are part of the match — "OUT" lands flush against the
    // following word, never as "OUT  word". Occurrences with fewer
    // trailing spaces, a tab, NBSPs or none at all must stay
    // byte-identical, both beside the matches and in a look-alike-only
    // file that never enters the candidate set. A run of three or four
    // spaces matches on its first two only (leftmost semantics), so the
    // spare spaces survive behind the replacement — proof the match is
    // exactly two spaces wide, not "the word plus some trailing
    // whitespace". Two matches sitting back-to-back each consume their
    // own trailing spaces, and matches at end-of-line and end-of-file
    // include the trailing spaces just the same.
    const file = join(tmpProj, "trailing-spaces.txt");
    const lookalikes = join(tmpProj, "trailing-space-lookalikes.txt");
    const lookalikeBytes = Buffer.from(
      "pad\npad three\npad\tfour\npad\u00a0\u00a0five\npadd  ed\n",
      "utf-8",
    );
    const original =
      "pad  one\n" +
      "padtwo\n" +
      "pad three\n" +
      "pad\tfour\n" +
      "pad\u00a0\u00a0five\n" +
      "pad  x six\n" +
      "pad   seven\n" +
      "pad    eight\n" +
      "pad  pad  nine\n" +
      "pad  \n" +
      "pad  ";
    const expected =
      "OUTone\n" +
      "padtwo\n" +
      "pad three\n" +
      "pad\tfour\n" +
      "pad\u00a0\u00a0five\n" +
      "OUTx six\n" +
      "OUT seven\n" +
      "OUT  eight\n" +
      "OUTOUTnine\n" +
      "OUT\n" +
      "OUT";
    await writeFile(file, original);
    await writeFile(lookalikes, lookalikeBytes);

    const args = { pattern: "pad  ", replacement: "OUT" };
    expect(args.pattern.endsWith("  ")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 8 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 8 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    // Each of the eight matches is exactly "pad  " (5 bytes) — the two
    // spaces included — so the file shrinks by 8 × (5 − 3) = 16 bytes.
    expect(result.originalBytes - result.newBytes).toBe(16);
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("OUTone");
    expect(lines[1]).toBe("padtwo");
    expect(lines[2]).toBe("pad three");
    expect(lines[3]).toBe("pad\tfour");
    expect(lines[4]).toBe("pad\u00a0\u00a0five");
    expect(lines[5]).toBe("OUTx six");
    expect(lines[6]).toBe("OUT seven");
    expect(lines[7]).toBe("OUT  eight");
    expect(lines[8]).toBe("OUTOUTnine");
    expect(lines[9]).toBe("OUT");
    expect(lines[10]).toBe("OUT");

    // The pure applyRegex path consumes the same two spaces per match.
    const pure = applyRegex(original, /pad  /g, "OUT", 100);
    expect(pure.count).toBe(8);
    expect(pure.updated).toBe(expected);

    // Same through the tool handler (JSON args path) — the trailing
    // spaces must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 8 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(lookalikes)).toEqual(lookalikeBytes);

    // A second pass finds nothing left to replace.
    const second = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(second.isError).not.toBe(true);
    expect(second.content[0]?.text).toContain("0 files, 0 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a single trailing space before CRLF line endings is replaced only where the space exists", async () => {
    // "end " (one trailing space) must match "end \r\n" but not "end\r\n",
    // and the CR/LF bytes after the consumed space stay untouched.
    const file = join(tmpProj, "trailing-space-crlf.txt");
    const original = "end \r\nend\r\nend\t\r\nend  \r\nend ";
    // The double-space line matches on its first space only; the second survives.
    const expected = "END\r\nend\r\nend\t\r\nEND \r\nEND";
    await writeFile(file, original);

    const args = { pattern: "end ", replacement: "END", roots: [file] };
    expect(args.pattern.endsWith(" ")).toBe(true);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
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

  test("caps literal LF-spanning replacements without changing the remaining match", async () => {
    const file = join(tmpProj, "lf-cap.txt");
    const original = "before café: foo\nbar after\r\nkeep foo\nbar tail";
    const expected = "before café: FB after\r\nkeep foo\nbar tail";
    await writeFile(file, original);

    const args = { pattern: "foo\nbar", replacement: "FB", roots: [file], maxMatchesPerFile: 1 };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(dryRun.text).toContain("cap hit");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.text).toContain("cap hit");
    expect(result.originalBytes).toBe(Buffer.byteLength(original));
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
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

  test("a literal search containing a carriage return replaces only the exact CR-joined match", async () => {
    // The pattern holds a real 0x0D byte between the words — a bare CR,
    // never a CRLF pair. Look-alikes whose separator is a CRLF pair, an
    // LF, a space, nothing, or the two-character backslash-r text must
    // stay byte-identical; only the two exact "key\rvalue" sites change.
    // The second file holds a CRLF look-alike only, so it never enters
    // the candidate set.
    const file = join(tmpProj, "literal-cr.txt");
    const other = join(tmpProj, "no-bare-cr.txt");
    const otherText = "key\r\nvalue\nkeyvalue\n";
    const original =
      "key\rvalue\nkey\r\nvalue\nkey\nvalue\nkeyvalue\nkey value\nkey\\rvalue\nx key\rvalue y\n";
    const expected =
      "KV\nkey\r\nvalue\nkey\nvalue\nkeyvalue\nkey value\nkey\\rvalue\nx KV y\n";
    await writeFile(file, original);
    await writeFile(other, otherText);

    const args = { pattern: "key\rvalue", replacement: "KV" };
    expect(args.pattern.includes("\r")).toBe(true);
    expect(args.pattern.includes("\n")).toBe(false);
    expect(args.pattern.includes("\\")).toBe(false);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(other)).toEqual(Buffer.from(otherText, "utf-8"));

    // CR census: the two match CRs are gone; the CRLF look-alike's pair
    // is the only CR left and its LF is untouched.
    const after = await readFile(file, "utf-8");
    expect(after.split("\r").length - 1).toBe(1);
    expect(after.split("\r\n").length - 1).toBe(1);
    expect(after.split("\n").length - 1).toBe(original.split("\n").length - 1);

    // Same through the tool handler.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a bare literal carriage-return search replaces every CR byte, including the CR inside each CRLF pair", async () => {
    // `\r` is the whole match: each 0x0D byte is replaced on its own. In
    // a CRLF pair only the CR is consumed — the LF stays behind — while
    // lone LFs and a CR-free file stay byte-identical.
    const file = join(tmpProj, "bare-cr.txt");
    const crFree = join(tmpProj, "cr-free.txt");
    const crFreeText = "alpha\nbeta gamma\n";
    const original = "one\rtwo\r\nthree\nfour\r";
    const expected = "one<CR>two<CR>\nthree\nfour<CR>";
    await writeFile(file, original);
    await writeFile(crFree, crFreeText);

    // Pure path first: the CR inside a CRLF is a match like any other.
    const pure = applyRegex("a\rb\r\nc\n", /\r/g, "<CR>", 100);
    expect(pure.count).toBe(2);
    expect(pure.updated).toBe("a<CR>b<CR>\nc\n");

    const args = { pattern: "\r", replacement: "<CR>", roots: [file, crFree] };
    expect(args.pattern).toHaveLength(1);
    expect(args.pattern.charCodeAt(0)).toBe(13);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    // No CR byte survives — the CRLF lost only its CR — and every LF is
    // still exactly where it was. No `\r` escape text was written.
    expect(after.includes(0x0d)).toBe(false);
    expect(after.filter((b) => b === 0x0a).length).toBe(2);
    expect(after.includes(Buffer.from("\\r"))).toBe(false);
    expect(await readFile(crFree)).toEqual(Buffer.from(crFreeText, "utf-8"));

    // Same through the tool handler.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a two-line literal with escaped metacharacters is replaced while surrounding text stays unchanged", async () => {
    // The escaped pattern spells `call(a.b);` + LF + `[done]` literally. The
    // dot-as-wildcard, joined-line, CRLF and swapped-order look-alikes must
    // stay byte-identical; the lines around each real match survive.
    const file = join(tmpProj, "two-line-literal.txt");
    const original =
      "// head café\n" +
      "x call(a.b);\n[done] y\n" +
      "call(aXb);\n[done]\n" +
      "call(a.b); [done]\n" +
      "call(a.b);\r\n[done]\n" +
      "[done]\ncall(a.b);\n" +
      "call(a.b);\n[done]";
    const expected =
      "// head café\n" +
      "x <DONE> y\n" +
      "call(aXb);\n[done]\n" +
      "call(a.b); [done]\n" +
      "call(a.b);\r\n[done]\n" +
      "[done]\ncall(a.b);\n" +
      "<DONE>";
    await writeFile(file, original);

    const args = {
      pattern: "call\\(a\\.b\\);\\n\\[done\\]",
      replacement: "<DONE>",
    };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);

    // Pure path agrees, and the two consumed LF bytes are the only loss.
    const pure = applyRegex(original, new RegExp(args.pattern, "g"), args.replacement, 100);
    expect(pure.count).toBe(2);
    expect(pure.updated).toBe(expected);
    expect(expected.split("\n").length).toBe(original.split("\n").length - 2);
  });

  test("a literal search spanning LF newlines replaces the multiline match and preserves surrounding content", async () => {
    // The literal "start\nmid\nend" holds two real LF bytes, so it only
    // matches the three words on three consecutive lines. One match ends
    // mid-line (the " tail" after it must survive), the second ends at EOF
    // with no trailing newline. Every look-alike — the space-joined line,
    // the wrong-tail triple, the rotated triple, and the CRLF file — must
    // stay byte-identical. The second file holds only partials, so it
    // never enters the candidate set.
    const file = join(tmpProj, "lf-span.txt");
    const partials = join(tmpProj, "lf-partials.txt");
    const original =
      "header keep café\r\n" +
      "start\nmid\nend tail\n" +
      "start mid end\n" +
      "start\nmid\ndelta\n" +
      "mid\nend\nstart\n" +
      "start\nmid\nend";
    const expected =
      "header keep café\r\n" +
      "AB tail\n" +
      "start mid end\n" +
      "start\nmid\ndelta\n" +
      "mid\nend\nstart\n" +
      "AB";
    const partialText =
      "start\nmid\n" +
      "mid\nend\n" +
      "start\r\nmid\r\nend\r\n";
    await writeFile(file, original);
    await writeFile(partials, partialText);

    const args = { pattern: "start\nmid\nend", replacement: "AB" };
    expect(args.pattern.includes("\n")).toBe(true);
    expect(args.pattern.includes("\\")).toBe(false);
    expect(args.pattern.split("\n").length - 1).toBe(2);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(partials, "utf-8")).toBe(partialText);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(partials, "utf-8")).toBe(partialText);

    // Assert each line individually so a mangled near-miss can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("header keep café\r");
    expect(lines[1]).toBe("AB tail");
    expect(lines[2]).toBe("start mid end");
    expect(lines[3]).toBe("start");
    expect(lines[4]).toBe("mid");
    expect(lines[5]).toBe("delta");
    expect(lines[6]).toBe("mid");
    expect(lines[7]).toBe("end");
    expect(lines[8]).toBe("start");
    expect(lines[9]).toBe("AB");
    expect(lines.length).toBe(10);

    // Line-ending census: the two matches consumed exactly four LF bytes;
    // the lone CRLF is untouched and no CR was added or lost.
    const after = await readFile(file, "utf-8");
    expect(after.split("\n").length - 1).toBe(original.split("\n").length - 1 - 4);
    expect(after.split("\r").length).toBe(original.split("\r").length);

    // Same through the tool handler (JSON args path) — the LF bytes must
    // survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler({ ...args, roots: [file] }, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(partials, "utf-8")).toBe(partialText);

    // The pure in-memory transform lands the same replacements and copies
    // every intervening gap verbatim.
    const { updated, count, capped } = applyRegex(original, /start\nmid\nend/g, "AB", 100);
    expect(count).toBe(2);
    expect(capped).toBe(false);
    expect(updated).toBe(expected);
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

  test("empty literal replacement removes an escaped literal while regex look-alikes stay byte-identical", async () => {
    const file = join(tmpProj, "strip-version.txt");
    // The literal `v1.2` is written as the escaped pattern `v1\.2`, so an
    // unescaped reading would also erase the look-alikes — `v1x2`, `v122`,
    // `v10.2`, the two-character `\.` text and uppercase `V1.2` must all
    // stay byte-identical. Every exact `v1.2` — at line start, as an
    // adjacent pair, mid-line, inside a longer token, and at EOF with no
    // trailing newline — is deleted.
    const original =
      "v1.2keep v1.2v1.2 mid v1.2 café\r\n" +
      "v1x2 v122 v10.2 v1\\.2 V1.2 no match\n" +
      "av1.2b tail v1.2";
    const expected =
      "keep  mid  café\r\n" +
      "v1x2 v122 v10.2 v1\\.2 V1.2 no match\n" +
      "ab tail ";
    await writeFile(file, original);

    const args = { pattern: "v1\\.2", replacement: "", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("keep  mid  café\r");
    expect(lines[1]).toBe("v1x2 v122 v10.2 v1\\.2 V1.2 no match");
    expect(lines[2]).toBe("ab tail ");

    // Same through the tool handler (JSON args path) — `""` arrives as a
    // real empty string, not an absent field.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("empty literal replacement removes a Unicode literal without mangling adjacent multibyte text", async () => {
    const file = join(tmpProj, "strip-unicode.txt");
    // The precomposed `caf\u00E9 🐈` literal is deleted at both sites. Its
    // neighbors — a decomposed `café` look-alike (different code
    // points, must not match), a ZWJ sequence, a non-BMP emoji and CJK —
    // must survive byte-for-byte: deleting multibyte matches must not
    // leave orphan continuation bytes behind.
    const original = Buffer.from(
      "前 caf\u00E9 🐈 後 🧑‍💻\r\ncafe\u0301 🐈 stays\n末 caf\u00E9 🐈!",
      "utf-8",
    );
    const expected = Buffer.from(
      "前  後 🧑‍💻\r\ncafe\u0301 🐈 stays\n末 !",
      "utf-8",
    );
    await writeFile(file, original);

    const args = { pattern: "caf\u00E9 🐈", replacement: "", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(original.length);
    expect(result.newBytes).toBe(expected.length);
    expect(await readFile(file)).toEqual(expected);

    // The pure applyRegex path deletes the same matches.
    const { updated, count } = applyRegex(original.toString("utf-8"), /caf\u00E9 🐈/g, "", 100);
    expect(count).toBe(2);
    expect(updated).toBe(expected.toString("utf-8"));
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

  test("a decomposed literal Unicode search replaces only the decomposed spelling, not the precomposed one", async () => {
    const file = join(tmpProj, "unicode-nfd.txt");
    // Reverse of the test above: the search is NFD (e + U+0301) plus a ZWJ
    // sequence, so the NFC look-alike (é) and a ZWJ-less split must survive.
    const original = "α café 🧑‍💻 ω\ncafé 🧑‍💻 ω\ncafé 🧑💻 ω\n";
    const expected = "α tea ω\ncafé 🧑‍💻 ω\ncafé 🧑💻 ω\n";
    await writeFile(file, original);

    const args = { pattern: "café 🧑‍💻", replacement: "tea", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
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

  test("replaces an ASCII literal touching a Unicode character on either side and leaves the Unicode untouched", async () => {
    const file = join(tmpProj, "unicode-adjacent-ascii.txt");
    // No separator between the ASCII match and the neighbors: a BMP letter
    // (é), a non-BMP emoji, a combining mark and CJK all abut "needle".
    const original = "é" + "needle" + "🐈\nneedle" + "\u0301 中needle文\n";
    const expected = "é" + "pin" + "🐈\npin" + "\u0301 中pin文\n";
    await writeFile(file, original);

    const args = { pattern: "needle", replacement: "pin", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    expect(after.toString("utf-8")).not.toContain("\uFFFD");
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

  test("an escaped literal matches nothing in files holding only its regex-reading look-alikes", async () => {
    const decoys = join(tmpProj, "regex-decoys.txt");
    const pieces = join(tmpProj, "literal-pieces.txt");
    // The literal "a.b(c)+d" never appears in either file. The first
    // file holds only strings the UNESCAPED pattern `a.b(c)+d` — "a",
    // any char, "b", one-or-more "c"s, "d" — would match, including
    // "a.bcd" whose literal dot still isn't the full literal, and "a bcd"
    // whose space satisfies the any-char. The second file holds pieces of
    // the literal itself — the parens without the `+`, the `+` with the
    // wrong tail, doubled parens, the uppercase spelling and a truncated
    // prefix — matching neither reading. If any escape were dropped, both
    // layers (the rg candidate scan and the JS RegExp) would report
    // matches; a zero count proves every metacharacter stayed literal.
    const decoyBytes = Buffer.from(
      "aXbcd aYbccd aWbcccd a.bcd café\r\na bcd aZbcd tail\n",
      "utf-8",
    );
    const pieceBytes = Buffer.from(
      "a.b(c)d a.b(c)+x a.b()c+d A.B(C)+D a.b(c) café\n",
      "utf-8",
    );
    await writeFile(decoys, decoyBytes);
    await writeFile(pieces, pieceBytes);
    expect(decoyBytes.includes("a.b(c)+d")).toBe(false);
    expect(pieceBytes.includes("a.b(c)+d")).toBe(false);

    const args = { pattern: "a\\.b\\(c\\)\\+d", replacement: "R" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("0 files, 0 replacements");
    expect(dryRun.originalBytes).toBe(0);
    expect(dryRun.newBytes).toBe(0);
    expect(await readFile(decoys)).toEqual(decoyBytes);
    expect(await readFile(pieces)).toEqual(pieceBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("0 files, 0 replacements");
    expect(result.originalBytes).toBe(0);
    expect(result.newBytes).toBe(0);
    expect(await readFile(decoys)).toEqual(decoyBytes);
    expect(await readFile(pieces)).toEqual(pieceBytes);

    // Same through the tool handler (JSON args path), dry run and apply.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dry of [true, false]) {
      const viaTool = await tool!.handler({ ...args, dryRun: dry }, { env: {} });
      expect(viaTool.isError).not.toBe(true);
      expect(viaTool.content[0]?.text).toContain("0 files, 0 replacements");
      expect(await readFile(decoys)).toEqual(decoyBytes);
      expect(await readFile(pieces)).toEqual(pieceBytes);
    }

    // Pure applyRegex path: the escaped pattern counts zero on the decoy
    // text, while the unescaped reading matches six strings there. The
    // fixture is match-rich under the regex reading, so the zero can only
    // come from the escapes being honored.
    const decoyText = decoyBytes.toString("utf-8");
    const escaped = applyRegex(decoyText, new RegExp(args.pattern, "g"), "R", 100);
    expect(escaped).toEqual({ updated: decoyText, count: 0, capped: false });
    const unescaped = applyRegex(decoyText, /a.b(c)+d/g, "R", 100);
    expect(unescaped.count).toBe(6);
    expect(unescaped.updated).not.toBe(decoyText);
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

  test("a capped literal pipe search does not rescan replacement pipes", async () => {
    const file = join(tmpProj, "capped-pipes.txt");
    const original = "|a||b|c｜│¦\r\n";
    const expected = "<|>a<|>|b|c｜│¦\r\n";
    await writeFile(file, original);

    const args = { pattern: "\\|", replacement: "<|>", roots: [file], maxMatchesPerFile: 2 };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected));
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

  test("a literal pipe spelled \\x7c, \\u007c or \\u{7c} replaces only U+007C", async () => {
    const piped = join(tmpProj, "escape-pipe.txt");
    const clean = join(tmpProj, "escape-clean.txt");
    // `\x7c`, `\u007c` and `\u{7c}` (u flag only — without it JS reads
    // `\u{` as a literal `u`) all spell the literal pipe with no `|`
    // byte in the pattern, so no alternation reading is possible. Only
    // U+007C may be replaced; the full-width bar (U+FF5C), box-drawing
    // bar (U+2502), broken bar (U+00A6) and every byte around them —
    // including the CRLF — must survive byte-for-byte, as must the
    // pipe-free file sitting in the same roots.
    const pipedOriginal = "a|b｜c│d¦e/f\r\n|x y| z|\n";
    const pipedExpected = "a=b｜c│d¦e/f\r\n=x y= z=\n";
    const cleanOriginal = Buffer.from("no bars ｜ │ ¦ here café\n", "utf-8");
    await writeFile(clean, cleanOriginal);

    for (const { spelling, flags } of [
      { spelling: "\\x7c", flags: undefined },
      { spelling: "\\u007c", flags: undefined },
      { spelling: "\\u{7c}", flags: "u" },
    ]) {
      await writeFile(piped, pipedOriginal);
      const args = { pattern: spelling, replacement: "=", flags, roots: [piped, clean] };
      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain("1 file, 4 replacements");
      expect(await readFile(piped)).toEqual(Buffer.from(pipedOriginal, "utf-8"));

      // The pure planner prices only the piped file.
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.plan.files.length).toBe(1);
        expect(plan.plan.files[0]?.matches).toBe(4);
        expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(pipedExpected, "utf-8"));
      }

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain("1 file, 4 replacements");
      expect(result.originalBytes).toBe(Buffer.byteLength(pipedOriginal, "utf-8"));
      expect(result.newBytes).toBe(Buffer.byteLength(pipedExpected, "utf-8"));
      expect(await readFile(piped)).toEqual(Buffer.from(pipedExpected, "utf-8"));
      expect(await readFile(clean)).toEqual(cleanOriginal);
    }

    // Pure applyRegex path — the same spellings compiled as JS RegExp.
    expect(applyRegex("a|b｜c", /\x7c/g, "-", 100).updated).toBe("a-b｜c");
    expect(applyRegex("a|b｜c", /\u007c/g, "-", 100).updated).toBe("a-b｜c");
    expect(applyRegex("a|b｜c", /\u{7c}/gu, "-", 100).updated).toBe("a-b｜c");
  });

  test("a backslash-pipe search replaces only the two-character `\\|` text, not bare pipes", async () => {
    const file = join(tmpProj, "md-escaped-pipe.txt");
    // Markdown tables write a cell pipe as `\|`. The pattern `\\\|` is a
    // literal backslash followed by a literal pipe: bare pipes, lone
    // backslashes, a backslash-slash pair and bar look-alikes all survive.
    const original = "a\\|b | c \\ d \\/ e｜f│g¦h \\\\| i\r\n";
    const expected = "a<PIPE>b | c \\ d \\/ e｜f│g¦h \\<PIPE> i\r\n";
    await writeFile(file, original);

    const args = { pattern: "\\\\\\|", replacement: "<PIPE>", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
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

  test("a literal question mark spelled [?], \\x3f, \\u003f or \\u{3f} replaces only U+003F", async () => {
    const marked = join(tmpProj, "question-spelling.txt");
    const clean = join(tmpProj, "question-spelling-clean.txt");
    // `[?]`, `\x3f`, `\u003f` and `\u{3f}` (u flag only — without it JS
    // reads `\u{` as a literal `u`) all spell the literal question mark.
    // The class can never read as a quantifier and the escapes carry no
    // `?` byte at all. Only U+003F may be replaced — at offset 0,
    // mid-token, in an adjacent run, before a CRLF and at EOF — while
    // the full-width mark (U+FF1F), double question (U+2047), Arabic
    // mark (U+061F), interrobang (U+203D), inverted mark (U+00BF) and
    // the emoji (U+2753) survive byte-for-byte, as does the mark-free
    // file sitting in the same roots.
    const markedOriginal = "?ask mid?dle pair??\r\nlook-alikes ？ ⁇ ؟ ‽ ¿ ❓\nend?";
    const markedExpected = "=ask mid=dle pair==\r\nlook-alikes ？ ⁇ ؟ ‽ ¿ ❓\nend=";
    const cleanOriginal = Buffer.from("no marks ？ ⁇ ؟ ‽ ¿ ❓ here café\n", "utf-8");
    await writeFile(clean, cleanOriginal);

    for (const { spelling, flags } of [
      { spelling: "[?]", flags: undefined },
      { spelling: "\\x3f", flags: undefined },
      { spelling: "\\u003f", flags: undefined },
      { spelling: "\\u{3f}", flags: "u" },
    ]) {
      await writeFile(marked, markedOriginal);
      const args = { pattern: spelling, replacement: "=", flags, roots: [marked, clean] };
      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain("1 file, 5 replacements");
      expect(await readFile(marked)).toEqual(Buffer.from(markedOriginal, "utf-8"));

      // The pure planner prices only the marked file.
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.plan.files.length).toBe(1);
        expect(plan.plan.files[0]?.matches).toBe(5);
        expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
      }

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain("1 file, 5 replacements");
      expect(result.originalBytes).toBe(Buffer.byteLength(markedOriginal, "utf-8"));
      expect(result.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
      expect(await readFile(marked)).toEqual(Buffer.from(markedExpected, "utf-8"));
      expect(await readFile(clean)).toEqual(cleanOriginal);
    }

    // Pure applyRegex path — the same spellings compiled as JS RegExp.
    expect(applyRegex("a?b？c", /[?]/g, "-", 100).updated).toBe("a-b？c");
    expect(applyRegex("a?b？c", /\x3f/g, "-", 100).updated).toBe("a-b？c");
    expect(applyRegex("a?b？c", /\u003f/g, "-", 100).updated).toBe("a-b？c");
    expect(applyRegex("a?b？c", /\u{3f}/gu, "-", 100).updated).toBe("a-b？c");
  });

  test("an unescaped `?` is an optional quantifier; only `ba\\?` rewrites the literal", async () => {
    const file = join(tmpProj, "question-quantifier.txt");
    const original = "ba? ba b\n";
    await writeFile(file, original);

    // Contrast case: `ba?` is "b, then an optional a". It consumes the
    // "ba" inside "ba?", the standalone "ba" and the lone "b" — three
    // matches, none of them the `?` byte, which survives the rewrite.
    const asQuantifier = await ashlrSearchReplaceRegex({ pattern: "ba?", replacement: "X" });
    expect(asQuantifier.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from("X? X X\n", "utf-8"));

    // The escaped spelling rewrites only the complete literal `ba?`.
    await writeFile(file, original);
    const literal = await ashlrSearchReplaceRegex({ pattern: "ba\\?", replacement: "X" });
    expect(literal.text).toContain("1 file, 1 replacement");
    expect(await readFile(file)).toEqual(Buffer.from("X ba b\n", "utf-8"));

    // Same contrast through the pure path.
    expect(applyRegex("ba? ba b\n", /ba?/g, "X", 100).updated).toBe("X? X X\n");
    expect(applyRegex("ba? ba b\n", /ba\?/g, "X", 100).updated).toBe("X ba b\n");
  });

  test("a bare `\\?\\?` pair search replaces only consecutive question marks, leaving lone marks and look-alikes untouched", async () => {
    const file = join(tmpProj, "question-pair.txt");
    const clean = join(tmpProj, "question-pair-clean.txt");
    // Every match is exactly two U+003F bytes. The `???` run proves
    // leftmost non-overlapping semantics: one pair is consumed and the
    // leftover `?` survives. Lone `?`s, the fullwidth `？？`, the
    // inverted `¿` and the pair-free clean file must stay byte-for-byte.
    const original =
      "?? ? ??? a??b ？？ café\r\n" +
      "x??y ??z??w\n" +
      "tail ??";
    const expected =
      "P ? P? aPb ？？ café\r\n" +
      "xPy PzPw\n" +
      "tail P";
    const cleanOriginal = Buffer.from("a?b ? ？？ ¿ café\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\?\\?", replacement: "P", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("P ? P? aPb ？？ café\r");
    expect(lines[1]).toBe("xPy PzPw");
    expect(lines[2]).toBe("tail P");

    // The pure in-memory transform consumes the same leftmost pair and
    // leaves the leftover mark.
    const pure = applyRegex("a??b ? c???d\n", /\?\?/g, "P", 100);
    expect(pure).toEqual({ updated: "aPb ? cP?d\n", count: 2, capped: false });

    // Same search through the tool handler (JSON args path) — the two
    // escaped marks must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a `?` in the replacement is inserted literally beside untouched question marks", async () => {
    const file = join(tmpProj, "question-replacement.txt");
    // `?` carries no special meaning in a JS replacement string, so each
    // inserted mark must land verbatim — beside the two pre-existing
    // marks in "b??c" that the pattern never touched.
    const original = "a ASK b??c ASK end\n";
    const expected = "a ? b??c ? end\n";
    await writeFile(file, original);

    const args = { pattern: "ASK", replacement: "?", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Two inserted marks plus the two originals in "b??c" — no more.
    expect(after.split("?").length - 1).toBe(4);

    // The pure in-memory transform inserts the same verbatim mark.
    const pure = applyRegex("x ASK y\n", /ASK/g, "?", 100);
    expect(pure).toEqual({ updated: "x ? y\n", count: 1, capped: false });
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

  test("literal caret search preserves adjacent backslashes and regex syntax", async () => {
    const file = join(tmpProj, "caret-regex-syntax.txt");
    const original = "\\^ ^\\ [^] $^ .^ *^\r\nplain ˆ ＾\n";
    const expected = "\\[^] [^]\\ [[^]] $[^] .[^] *[^]\r\nplain ˆ ＾\n";
    await writeFile(file, original);

    const args = { pattern: "\\^", replacement: "[$&]", flags: "m", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected));
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

  test("a bare `\\^` replaces only literal carets at every boundary while look-alikes and line starts stay put", async () => {
    const file = join(tmpProj, "bare-caret.txt");
    const clean = join(tmpProj, "bare-caret-clean.txt");
    // Every U+005E is the target: at offset 0, mid-token, in an adjacent
    // `^^` run, before a CRLF and at EOF with no trailing newline. The
    // caret look-alikes (U+02C6, U+FF3E, U+2227, U+2038, U+2303, U+02C4)
    // and every line start — the positions an unescaped `^` would anchor
    // on — must survive byte-for-byte, as must the caret-free file.
    const original =
      "^start a^b x^^y ˆ ＾ ∧ ‸ ⌃ ˄ café^\r\n" +
      "mid^line plain\n" +
      "tail ^";
    const expected =
      "-start a-b x--y ˆ ＾ ∧ ‸ ⌃ ˄ café-\r\n" +
      "mid-line plain\n" +
      "tail -";
    const cleanOriginal = Buffer.from("no carets ˆ ＾ ∧ ‸ ⌃ ˄ here café\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\^", replacement: "-", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    // The pure planner prices only the careted file.
    const plan = await planSearchReplaceRegex(args);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.plan.files.length).toBe(1);
      expect(plan.plan.files[0]?.matches).toBe(7);
      expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    }

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("-start a-b x--y ˆ ＾ ∧ ‸ ⌃ ˄ café-\r");
    expect(lines[1]).toBe("mid-line plain");
    expect(lines[2]).toBe("tail -");

    // The pure in-memory transform hits the same carets at the same
    // boundaries — offset 0, mid-token, an adjacent run — and nothing else.
    const pure = applyRegex("^a b^c^^d ˆ\n", /\^/g, "-", 100);
    expect(pure).toEqual({ updated: "-a b-c--d ˆ\n", count: 4, capped: false });

    // Same literal search through the tool handler (JSON args path) — the
    // escaped caret must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a literal caret spelled [\\^], \\x5e, \\u005e or \\u{5e} replaces only U+005E", async () => {
    const careted = join(tmpProj, "escape-caret.txt");
    const clean = join(tmpProj, "escape-caret-clean.txt");
    // `[\^]`, `\x5e`, `\u005e` and `\u{5e}` (u flag only — without it JS
    // reads `\u{` as a literal `u`) all spell the literal caret with no
    // way to read it as an anchor. Only U+005E may be replaced; the
    // modifier circumflex (U+02C6), fullwidth caret (U+FF3E), logical
    // and (U+2227), caret (U+2038), up arrowhead (U+2303) and every byte
    // around them — including the CRLF — must survive byte-for-byte, as
    // must the caret-free file sitting in the same roots.
    const caretedOriginal = "a^bˆc＾d∧e‸f⌃g/h^\r\n^x y^ z^";
    const caretedExpected = "a=bˆc＾d∧e‸f⌃g/h=\r\n=x y= z=";
    const cleanOriginal = Buffer.from("no carets ˆ ＾ ∧ ‸ ⌃ ˄ café\n", "utf-8");
    await writeFile(clean, cleanOriginal);

    for (const { spelling, flags } of [
      { spelling: "[\\^]", flags: undefined },
      { spelling: "\\x5e", flags: undefined },
      { spelling: "\\u005e", flags: undefined },
      { spelling: "\\u{5e}", flags: "u" },
    ]) {
      await writeFile(careted, caretedOriginal);
      const args = { pattern: spelling, replacement: "=", flags, roots: [careted, clean] };
      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain("1 file, 5 replacements");
      expect(await readFile(careted)).toEqual(Buffer.from(caretedOriginal, "utf-8"));

      // The pure planner prices only the careted file.
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.plan.files.length).toBe(1);
        expect(plan.plan.files[0]?.matches).toBe(5);
        expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(caretedExpected, "utf-8"));
      }

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain("1 file, 5 replacements");
      expect(result.originalBytes).toBe(Buffer.byteLength(caretedOriginal, "utf-8"));
      expect(result.newBytes).toBe(Buffer.byteLength(caretedExpected, "utf-8"));
      expect(await readFile(careted)).toEqual(Buffer.from(caretedExpected, "utf-8"));
      expect(await readFile(clean)).toEqual(cleanOriginal);
    }

    // Pure applyRegex path — the same spellings compiled as JS RegExp.
    expect(applyRegex("a^b＾c", /[\^]/g, "-", 100).updated).toBe("a-b＾c");
    expect(applyRegex("a^b＾c", /\x5e/g, "-", 100).updated).toBe("a-b＾c");
    expect(applyRegex("a^b＾c", /\u005e/g, "-", 100).updated).toBe("a-b＾c");
    expect(applyRegex("a^b＾c", /\u{5e}/gu, "-", 100).updated).toBe("a-b＾c");
  });

  test("a bare `\\^\\^` pair search replaces only consecutive carets, leaving lone carets and look-alikes untouched", async () => {
    const file = join(tmpProj, "caret-pair.txt");
    const clean = join(tmpProj, "caret-pair-clean.txt");
    // Every match is exactly two U+005E bytes. The `^^^` run proves
    // leftmost non-overlapping semantics: one pair is consumed and the
    // leftover `^` survives. Lone `^`s, the fullwidth `＾＾`, and the
    // single-caret-only clean file must stay byte-for-byte.
    const original =
      "^^ ^ ^^^ a^^b ＾＾ café\r\n" +
      "x^^y ^^z^^w\n" +
      "tail ^^";
    const expected =
      "P ^ P^ aPb ＾＾ café\r\n" +
      "xPy PzPw\n" +
      "tail P";
    const cleanOriginal = Buffer.from("a^b ^ ＾＾ no pairs café\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\^\\^", replacement: "P", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("P ^ P^ aPb ＾＾ café\r");
    expect(lines[1]).toBe("xPy PzPw");
    expect(lines[2]).toBe("tail P");

    // The pure in-memory transform consumes the same leftmost pair and
    // leaves the leftover caret.
    const pure = applyRegex("a^^b ^ c^^^d\n", /\^\^/g, "P", 100);
    expect(pure).toEqual({ updated: "aPb ^ cP^d\n", count: 2, capped: false });

    // Same search through the tool handler (JSON args path) — the two
    // escaped carets must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a `^` in the replacement is inserted literally beside untouched carets", async () => {
    const file = join(tmpProj, "caret-replacement.txt");
    // `^` carries no special meaning in a JS replacement string, so each
    // inserted caret must land verbatim — beside the two pre-existing
    // carets in "b^^c" that the pattern never touched.
    const original = "a POW b^^c POW end\n";
    const expected = "a ^ b^^c ^ end\n";
    await writeFile(file, original);

    const args = { pattern: "POW", replacement: "^", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Two inserted carets plus the two originals in "b^^c" — no more.
    expect(after.split("^").length - 1).toBe(4);

    // The pure in-memory transform inserts the same verbatim caret.
    const pure = applyRegex("x POW y\n", /POW/g, "^", 100);
    expect(pure).toEqual({ updated: "x ^ y\n", count: 1, capped: false });
  });

  test("a quantified or captured `\\^` and the i flag still touch only literal carets, via the tool handler across files", async () => {
    const a = join(tmpProj, "caret-quant-a.txt");
    const b = join(tmpProj, "caret-quant-b.txt");
    // `\^+` swallows a whole run of carets as one match; `(\^)` captures
    // the caret for `$1`. The i flag must not widen the match to
    // look-alikes (U+02C6, U+FF3E) or line starts, and a negated class
    // `[^x]` in a neighbouring file shows the caret inside a class is
    // not mistaken for the literal search.
    const origA = "x^^^y ^z\n^line\nˆ ＾ plain\n";
    const origB = "no carets here ˆ ＾\n";
    await writeFile(a, origA);
    await writeFile(b, origB);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();

    // Quantified run: 3 carets -> one match, then two singles = 3 matches.
    const quant = await tool!.handler(
      { pattern: "\\^+", replacement: "_", flags: "mi", roots: [a, b] },
      { env: {} },
    );
    expect(quant.isError).toBeFalsy();
    expect(await readFile(a, "utf-8")).toBe("x_y _z\n_line\nˆ ＾ plain\n");
    expect(await readFile(b, "utf-8")).toBe(origB);

    // Captured caret: `$1` reproduces the caret between the brackets.
    await writeFile(a, origA);
    const cap = await tool!.handler(
      { pattern: "(\\^)", replacement: "<$1>", roots: [a, b] },
      { env: {} },
    );
    expect(cap.isError).toBeFalsy();
    expect(await readFile(a, "utf-8")).toBe(
      "x<^><^><^>y <^>z\n<^>line\nˆ ＾ plain\n",
    );
    expect(await readFile(b, "utf-8")).toBe(origB);
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

  test("a plus between digits replaces only that plus, keeping the digits and other pluses", async () => {
    const file = join(tmpProj, "digit-plus.txt");
    // `(\d)\+(\d)` with `$1 plus $2` swaps just the `+` byte: both
    // neighbouring digits are re-emitted, while pluses beside letters,
    // spaces, line edges and a `+` next to a `+` stay put. (rg has no
    // lookaround, so captures stand in for it.) "7+8+9" shares the middle
    // digit between two candidates, so only the first pair matches.
    const original = "1+2 a+b 3 + 4 +5 6+\n7+8+9 ++1 1++\n";
    const expected = "1 plus 2 a+b 3 + 4 +5 6+\n7 plus 8+9 ++1 1++\n";
    await writeFile(file, original);

    const args = {
      pattern: "(\\d)\\+(\\d)",
      replacement: "$1 plus $2",
      roots: [file],
    };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Pure path agrees.
    expect(applyRegex("1+2 a+b", /(\d)\+(\d)/g, "$1-$2", 100).updated).toBe("1-2 a+b");
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

  test("a bare `\\+\\+` pair search replaces only consecutive plus signs, leaving lone pluses and look-alikes untouched", async () => {
    const file = join(tmpProj, "plus-pair.txt");
    const clean = join(tmpProj, "plus-pair-clean.txt");
    // Every match is exactly two U+002B bytes. The `+++` run proves
    // leftmost non-overlapping semantics: one pair is consumed and the
    // leftover `+` survives. Lone `+`s, the fullwidth `＋＋`, and the
    // single-plus-only clean file must stay byte-for-byte.
    const original =
      "++ + +++ a++b ＋＋ café\r\n" +
      "x++y ++z++w\n" +
      "tail ++";
    const expected =
      "P + P+ aPb ＋＋ café\r\n" +
      "xPy PzPw\n" +
      "tail P";
    const cleanOriginal = Buffer.from("a+b 1+2 ＋＋ no pairs\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\+\\+", replacement: "P", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("P + P+ aPb ＋＋ café\r");
    expect(lines[1]).toBe("xPy PzPw");
    expect(lines[2]).toBe("tail P");

    // The pure in-memory transform consumes the same leftmost pair and
    // leaves the leftover plus.
    const pure = applyRegex("a++b + c+++d\n", /\+\+/g, "P", 100);
    expect(pure).toEqual({ updated: "aPb + cP+d\n", count: 2, capped: false });

    // Same search through the tool handler (JSON args path) — the two
    // escaped pluses must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
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

  test("a literal plus spelled [+], \\x2b, \\u002b or \\u{2b} replaces only U+002B", async () => {
    const marked = join(tmpProj, "plus-spelling.txt");
    const clean = join(tmpProj, "plus-spelling-clean.txt");
    // `[+]`, `\x2b`, `\u002b` and `\u{2b}` (u flag only — without it JS
    // reads `\u{` as a literal `u`) all spell the literal plus. The class
    // can never read as a quantifier and the escapes carry no `+` byte at
    // all. Only U+002B may be replaced — at offset 0, mid-token, in an
    // adjacent run, before a CRLF and at EOF — while the fullwidth plus
    // (U+FF0B), small plus (U+FE62), heavy plus emoji (U+2795) and
    // plus-minus (U+00B1) survive byte-for-byte, as does the plus-free
    // file sitting in the same roots.
    const markedOriginal = "+add mid+dle pair++\r\nlook-alikes ＋ ﹢ ➕ ±\nend+";
    const markedExpected = "=add mid=dle pair==\r\nlook-alikes ＋ ﹢ ➕ ±\nend=";
    const cleanOriginal = Buffer.from("no pluses ＋ ﹢ ➕ ± here café\n", "utf-8");
    await writeFile(clean, cleanOriginal);

    for (const { spelling, flags } of [
      { spelling: "[+]", flags: undefined },
      { spelling: "\\x2b", flags: undefined },
      { spelling: "\\u002b", flags: undefined },
      { spelling: "\\u{2b}", flags: "u" },
    ]) {
      await writeFile(marked, markedOriginal);
      const args = { pattern: spelling, replacement: "=", flags, roots: [marked, clean] };
      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain("1 file, 5 replacements");
      expect(await readFile(marked)).toEqual(Buffer.from(markedOriginal, "utf-8"));

      // The pure planner prices only the marked file.
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.plan.files.length).toBe(1);
        expect(plan.plan.files[0]?.matches).toBe(5);
        expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
      }

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain("1 file, 5 replacements");
      expect(result.originalBytes).toBe(Buffer.byteLength(markedOriginal, "utf-8"));
      expect(result.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
      expect(await readFile(marked)).toEqual(Buffer.from(markedExpected, "utf-8"));
      expect(await readFile(clean)).toEqual(cleanOriginal);
    }

    // Pure applyRegex path — the same spellings compiled as JS RegExp.
    expect(applyRegex("a+b＋c", /[+]/g, "-", 100).updated).toBe("a-b＋c");
    expect(applyRegex("a+b＋c", /\x2b/g, "-", 100).updated).toBe("a-b＋c");
    expect(applyRegex("a+b＋c", /\u002b/g, "-", 100).updated).toBe("a-b＋c");
    expect(applyRegex("a+b＋c", /\u{2b}/gu, "-", 100).updated).toBe("a-b＋c");
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

    // The pure in-memory transform sees the same U+002A-only matches.
    const pure = applyRegex("a*b ＊c\n", /\*/g, "X", 100);
    expect(pure).toEqual({ updated: "aXb ＊c\n", count: 1, capped: false });
  });

  test("a bare `\\*\\*` pair search replaces only consecutive asterisks, leaving lone stars and look-alikes untouched", async () => {
    const file = join(tmpProj, "asterisk-pair.txt");
    const clean = join(tmpProj, "asterisk-pair-clean.txt");
    // Every match is exactly two U+002A bytes. The `***` run proves
    // leftmost non-overlapping semantics: one pair is consumed and the
    // leftover `*` survives. Lone `*`s, the fullwidth `＊＊`, and the
    // single-star-only clean file must stay byte-for-byte.
    const original =
      "** * *** a**b ＊＊ café\r\n" +
      "x**y **z**w\n" +
      "tail **";
    const expected =
      "P * P* aPb ＊＊ café\r\n" +
      "xPy PzPw\n" +
      "tail P";
    const cleanOriginal = Buffer.from("a*b 1*2 ＊＊ no pairs\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\*\\*", replacement: "P", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("P * P* aPb ＊＊ café\r");
    expect(lines[1]).toBe("xPy PzPw");
    expect(lines[2]).toBe("tail P");

    // The pure in-memory transform consumes the same leftmost pair and
    // leaves the leftover star.
    const pure = applyRegex("a**b * c***d\n", /\*\*/g, "P", 100);
    expect(pure).toEqual({ updated: "aPb * cP*d\n", count: 2, capped: false });

    // Same search through the tool handler (JSON args path) — the two
    // escaped stars must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a `*` in the replacement is inserted verbatim beside untouched asterisks", async () => {
    const file = join(tmpProj, "asterisk-replacement.txt");
    // `*` carries no special meaning in a JS replacement string, so each
    // inserted star must land verbatim — beside the two pre-existing
    // stars in "a**b" that the pattern never touched.
    const original = "1 STAR 1=2 a**b STAR café\r\nlast STAR\n";
    const expected = "1 * 1=2 a**b * café\r\nlast *\n";
    await writeFile(file, original);

    const args = { pattern: "STAR", replacement: "*", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Three inserted stars plus the two originals in "a**b" — no more.
    expect(after.split("*").length - 1).toBe(5);

    // The pure in-memory transform inserts the same verbatim star.
    const pure = applyRegex("x STAR y\n", /STAR/g, "*", 100);
    expect(pure).toEqual({ updated: "x * y\n", count: 1, capped: false });
  });

  test("a literal asterisk spelled [*], \\x2A, \\u002A or \\u{2A} replaces only U+002A", async () => {
    const marked = join(tmpProj, "asterisk-spelling.txt");
    const clean = join(tmpProj, "asterisk-spelling-clean.txt");
    // `[*]`, `\x2A`, `\u002A` and `\u{2A}` (u flag only — without it JS
    // reads `\u{` as a literal `u`) all spell the literal asterisk.
    // The class can never read as a quantifier and the escapes carry no
    // `*` byte at all. Only U+002A may be replaced — at offset 0,
    // mid-token, in an adjacent run, before a CRLF and at EOF — while
    // the fullwidth asterisk (U+FF0A), small asterisk (U+FE61), star
    // operator (U+2217), asterism (U+2042), low asterisk (U+204E) and
    // black star (U+2605) survive byte-for-byte, as does the star-free
    // file sitting in the same roots.
    const markedOriginal = "*ask mid*dle pair**\r\nlook-alikes ＊ ﹡ ∗ ⁂ ⁎ ★\nend*";
    const markedExpected = "=ask mid=dle pair==\r\nlook-alikes ＊ ﹡ ∗ ⁂ ⁎ ★\nend=";
    const cleanOriginal = Buffer.from("no stars ＊ ﹡ ∗ ⁂ ⁎ ★ here café\n", "utf-8");
    await writeFile(clean, cleanOriginal);

    for (const { spelling, flags } of [
      { spelling: "[*]", flags: undefined },
      { spelling: "\\x2A", flags: undefined },
      { spelling: "\\u002A", flags: undefined },
      { spelling: "\\u{2A}", flags: "u" },
    ]) {
      await writeFile(marked, markedOriginal);
      const args = { pattern: spelling, replacement: "=", flags, roots: [marked, clean] };
      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain("1 file, 5 replacements");
      expect(await readFile(marked)).toEqual(Buffer.from(markedOriginal, "utf-8"));

      // The pure planner prices only the marked file.
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.plan.files.length).toBe(1);
        expect(plan.plan.files[0]?.matches).toBe(5);
        expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
      }

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain("1 file, 5 replacements");
      expect(result.originalBytes).toBe(Buffer.byteLength(markedOriginal, "utf-8"));
      expect(result.newBytes).toBe(Buffer.byteLength(markedExpected, "utf-8"));
      expect(await readFile(marked)).toEqual(Buffer.from(markedExpected, "utf-8"));
      expect(await readFile(clean)).toEqual(cleanOriginal);
    }

    // Pure applyRegex path — the same spellings compiled as JS RegExp.
    expect(applyRegex("a*b＊c", /[*]/g, "-", 100).updated).toBe("a-b＊c");
    expect(applyRegex("a*b＊c", /\x2A/g, "-", 100).updated).toBe("a-b＊c");
    expect(applyRegex("a*b＊c", /\u002A/g, "-", 100).updated).toBe("a-b＊c");
    expect(applyRegex("a*b＊c", /\u{2A}/gu, "-", 100).updated).toBe("a-b＊c");
  });

  test("a literal asterisk inside glob and comment text leaves the surrounding text intact", async () => {
    const file = join(tmpProj, "asterisk-context.txt");
    const clean = join(tmpProj, "asterisk-context-clean.txt");
    // `\*\.ts` is a literal star, then a literal dot, then "ts": it hits
    // the glob "*.ts" but not "a.ts", "x.ts" or "*xts" (unescaped `.` and a
    // wildcard `*` would). `/\*` hits only "/*" (the comment opener and the
    // glob in "src/*.ts"), never "*/" or the "/" in "src/".
    const original = "glob src/*.ts and a.ts *xts\n/* note */ café ＊.ts\r\nmd **bold** end\n";
    const clean0 = Buffer.from("src/a.ts ＊.ts */ no star-dot\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, clean0);

    const glob = { pattern: "\\*\\.ts", replacement: "GLOB", roots: [file, clean] };
    const globResult = await ashlrSearchReplaceRegex(glob);
    expect(globResult.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(
      "glob src/GLOB and a.ts *xts\n/* note */ café ＊.ts\r\nmd **bold** end\n",
    );
    expect(await readFile(clean)).toEqual(clean0);

    await writeFile(file, original);
    const opener = { pattern: "/\\*", replacement: "//", roots: [file, clean] };
    const result = await ashlrSearchReplaceRegex(opener);
    // "src/*.ts" also contains "/*", so two matches.
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "glob src//.ts and a.ts *xts\n// note */ café ＊.ts\r\nmd **bold** end\n",
    );
    expect(await readFile(clean)).toEqual(clean0);

    // Markdown emphasis: `\*\*` strips only the bold markers, keeping the word.
    const md = applyRegex("md **bold** and *it*\n", /\*\*/g, "", 100);
    expect(md).toEqual({ updated: "md bold and *it*\n", count: 2, capped: false });
  });

  test("literal asterisk composes with anchors, quantifiers, escaped backslashes and captures", async () => {
    const file = join(tmpProj, "asterisk-compose.txt");
    const clean = join(tmpProj, "asterisk-compose-clean.txt");
    const cleanOriginal = Buffer.from("＊ item ﹡ ∗ ★ no ascii star\n", "utf-8");
    await writeFile(clean, cleanOriginal);
    const original = "* item\n  * nested\na * b\n** bold ***\npath\\*x ＊ end*\n";
    const run = async (args: Record<string, unknown>, expected: string, count: string) => {
      await writeFile(file, original);
      const result = await ashlrSearchReplaceRegex({ ...args, roots: [file, clean] } as never);
      expect(result.text).toContain(count);
      expect(await readFile(file, "utf-8")).toBe(expected);
      expect(await readFile(clean)).toEqual(cleanOriginal);
    };

    // `^\*` with the m flag hits only a star at line start — not the
    // indented, mid-line or trailing stars.
    await run(
      { pattern: "^\\*", replacement: "-", flags: "m" },
      "- item\n  * nested\na * b\n-* bold ***\npath\\*x ＊ end*\n",
      "1 file, 2 replacements",
    );

    // `\*+` consumes a whole run per match, so `**` and `***` each count once.
    await run(
      { pattern: "\\*+", replacement: "#" },
      "# item\n  # nested\na # b\n# bold #\npath\\#x ＊ end#\n",
      "1 file, 7 replacements",
    );

    // `\\\*` is a literal backslash then a literal star: only "\*" matches.
    await run(
      { pattern: "\\\\\\*", replacement: "STAR" },
      "* item\n  * nested\na * b\n** bold ***\npathSTARx ＊ end*\n",
      "1 file, 1 replacement",
    );

    // A captured star run is re-emitted by `$1` with its exact width.
    await run(
      { pattern: "(\\*{2,}) ", replacement: "<$1> " },
      "* item\n  * nested\na * b\n<**> bold ***\npath\\*x ＊ end*\n",
      "1 file, 1 replacement",
    );
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

  test("adjacent literal matches are each replaced once without rescanning output", async () => {
    const file = join(tmpProj, "adjacent.txt");
    const original = "catcatcat café\r\nCAT catca\ncatcat";
    const expected = "[cat][cat][cat] café\r\nCAT [cat]ca\n[cat][cat]";
    await writeFile(file, original);
    const args = { pattern: "cat", replacement: "[cat]", roots: [file] };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 6 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 6 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original));
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));

    expect(applyRegex(original, /cat/g, "[cat]", 100)).toEqual({
      updated: expected, count: 6, capped: false,
    });
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

  test("a literal repeated on a single line with no newline replaces every occurrence and keeps each gap verbatim", async () => {
    const file = join(tmpProj, "one-line-repeats.txt");
    // One physical line, no trailing newline: "k=v" recurs five times with
    // gaps of varied shape — a single space, a tab, a run of punctuation,
    // Unicode, and a near-miss ("k=w", "K=v") — so only the literal may change.
    const gaps = [" ", "\t", " ;; (k=w) ", " café 猫 ", " K=v "];
    const original = `k=v${gaps[0]}k=v${gaps[1]}k=v${gaps[2]}k=v${gaps[3]}k=v${gaps[4]}`;
    await writeFile(file, original);

    // Replacement shorter, equal-length and longer than the match must all
    // leave the gaps intact and report five replacements.
    for (const replacement of ["", "a=b", "key=value!"]) {
      await writeFile(file, original);
      const args = { pattern: "k\\=v", replacement, roots: [file] };

      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain("1 file, 5 replacements");
      expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain("1 file, 5 replacements");
      // Gaps interleave the replacement at every position; the final gap
      // trails the last match.
      const expected = gaps.map((g) => `${replacement}${g}`).join("");
      expect(await readFile(file, "utf-8")).toBe(expected);
      expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

      const pure = applyRegex(original, /k=v/g, replacement, 100);
      expect(pure.count).toBe(5);
      expect(pure.capped).toBe(false);
      expect(pure.updated).toBe(expected);
    }
  });

  test("a replacement that contains the search literal is applied once per occurrence and never rescanned", async () => {
    const file = join(tmpProj, "self-containing-replacement.txt");
    // "cat" → "cat-cat": the output holds the search term again, so a
    // rescanning implementation would grow without bound or double-count.
    // Three occurrences (start, mid-line, EOF) plus a "concat" substring
    // and a "CAT" look-alike; text between them must survive byte-for-byte.
    const original = "cat sat\r\nthe cat café CAT\nconcat ends with cat";
    const expected = "cat-cat sat\r\nthe cat-cat café CAT\nconcat-cat ends with cat-cat";
    await writeFile(file, original);

    const args = { pattern: "cat", replacement: "cat-cat", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    const pure = applyRegex(original, /cat/g, "cat-cat", 100);
    expect(pure.count).toBe(4);
    expect(pure.capped).toBe(false);
    expect(pure.updated).toBe(expected);
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

  test("a literal ellipsis `\\.\\.\\.` replaces only three-period runs, never other triples or a lone period", async () => {
    const file = join(tmpProj, "ellipsis.txt");
    // "a.b.c" and "x-y-z" are triples an unescaped `...` would consume; "1..2"
    // and a lone "." must survive. A four-period run matches on its first
    // three periods and leaves the fourth.
    const original = "wait... a.b.c x-y-z 1..2 end. more.... done\n";
    const expected = "wait\u2026 a.b.c x-y-z 1..2 end. more\u2026. done\n";
    await writeFile(file, original);

    const args = { pattern: "\\.\\.\\.", replacement: "\u2026", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a literal period in a domain name replaces only the dots, across files, leaving dot-free look-alikes", async () => {
    const a = join(tmpProj, "hosts-a.txt");
    const b = join(tmpProj, "hosts-b.txt");
    const c = join(tmpProj, "hosts-c.txt");
    await writeFile(a, "api.example.com example-com exampleXcom\n");
    await writeFile(b, "v3.14 3x14\nwww.a.b\n");
    const cOriginal = "exampleXcom no dots\n";
    await writeFile(c, cOriginal);

    const result = await ashlrSearchReplaceRegex({
      pattern: "\\.",
      replacement: "[dot]",
      roots: [a, b, c],
    });
    expect(result.text).toContain("2 files, 5 replacements");
    expect(await readFile(a, "utf-8")).toBe("api[dot]example[dot]com example-com exampleXcom\n");
    expect(await readFile(b, "utf-8")).toBe("v3[dot]14 3x14\nwww[dot]a[dot]b\n");
    expect(await readFile(c, "utf-8")).toBe(cOriginal);
  });

  test("a literal period written as the `[.]` class replaces only U+002E — hex and unicode spellings match the same set", async () => {
    const file = join(tmpProj, "period-class.txt");
    // Periods sit at every boundary: offset 0, mid-token, an adjacent
    // `..` run, just before a CRLF, and at EOF with no trailing newline.
    // Everything else — letters, digits, space, colon, comma, and the
    // dot look-alikes U+2024 ONE DOT LEADER, U+FF0E FULLWIDTH FULL STOP,
    // U+00B7 MIDDLE DOT and U+2026 HORIZONTAL ELLIPSIS — is a character
    // an unescaped `.` would also consume; only the seven real periods
    // may change.
    const original = ".lead v1.2 a..b end.\r\nnext 1.5 tail: x,y ․．·… last.";
    const expected = "<.>lead v1<.>2 a<.><.>b end<.>\r\nnext 1<.>5 tail: x,y ․．·… last<.>";
    await writeFile(file, original);

    // `<$&>` wraps each whole match in angle brackets — if `[.]`
    // consumed even one byte beside the period, the brackets would
    // surround more than a lone `.`.
    const args = { pattern: "[.]", replacement: "<$&>", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file, "utf-8")).toBe(expected);

    // The same literal spelled `\x2E` or `\u002E` selects the identical
    // U+002E set — under the s (dotall) flag, where a misread bare `.`
    // would additionally swallow the `\r` and `\n` and push the count
    // past seven.
    for (const spelling of ["\\x2E", "\\u002E"]) {
      await writeFile(file, original);
      const res = await ashlrSearchReplaceRegex({
        pattern: spelling,
        replacement: "|",
        roots: [file],
        flags: "s",
      });
      expect(res.text).toContain("1 file, 7 replacements");
      expect(await readFile(file, "utf-8")).toBe(
        "|lead v1|2 a||b end|\r\nnext 1|5 tail: x,y ․．·… last|",
      );
    }

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);

    // And the pure applyRegex path lands the same byte-for-byte result.
    const pure = applyRegex(original, /[.]/g, "<$&>", 100);
    expect(pure.count).toBe(7);
    expect(pure.capped).toBe(false);
    expect(pure.updated).toBe(expected);
  });

  test("a bare `\\.\\.` pair search replaces only consecutive periods, leaving lone periods and look-alikes untouched", async () => {
    const file = join(tmpProj, "period-pair.txt");
    const clean = join(tmpProj, "period-pair-clean.txt");
    // Every match is exactly two U+002E bytes. The `...` run proves
    // leftmost non-overlapping semantics: one pair is consumed and the
    // leftover `.` survives. Lone `.`s, the U+2025 TWO DOT LEADER `‥`,
    // the fullwidth `．．`, and the pair-free clean file must stay
    // byte-for-byte.
    const original =
      ".. . ... a..b ‥ ．． café\r\n" +
      "x..y ..z..w\n" +
      "tail ..";
    const expected =
      "P . P. aPb ‥ ．． café\r\n" +
      "xPy PzPw\n" +
      "tail P";
    const cleanOriginal = Buffer.from("a.b . ‥ ．． no pairs café\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanOriginal);

    const args = { pattern: "\\.\\.", replacement: "P", roots: [file, clean] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("P . P. aPb ‥ ．． café\r");
    expect(lines[1]).toBe("xPy PzPw");
    expect(lines[2]).toBe("tail P");

    // The pure in-memory transform consumes the same leftmost pair and
    // leaves the leftover period.
    const pure = applyRegex("a..b . c...d\n", /\.\./g, "P", 100);
    expect(pure).toEqual({ updated: "aPb . cP.d\n", count: 2, capped: false });

    // Same search through the tool handler (JSON args path) — the two
    // escaped periods must survive transport and still match literally.
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanOriginal);
  });

  test("a literal period at a literal's edge requires the dot — `\\.com` and `end\\.` match only the dotted spellings", async () => {
    const file = join(tmpProj, "period-edges.txt");
    // `.com` leads its literal and `end.` trails its own; in each case
    // the period is the only part of the spelling that can go missing.
    // The look-alikes — "xcom"/"-com"/"acom" (what an unescaped `.com`
    // would swallow), ".co m", and "end,"/"endx"/"end-"/bare "end"
    // (what an unescaped `end.` would swallow) — must stay identical.
    // The `.com` at offset 0 and the `end.` at EOF pin the boundaries.
    const original =
      ".com xcom -com acom .co m\r\n" +
      "end. end, endx end- the end\n" +
      "tail .com end.";
    await writeFile(file, original);

    // Leading edge: only the two real ".com" spellings move.
    const leadArgs = { pattern: "\\.com", replacement: "<D>", roots: [file] };
    const leadDry = await ashlrSearchReplaceRegex({ ...leadArgs, dryRun: true });
    expect(leadDry.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const leadResult = await ashlrSearchReplaceRegex(leadArgs);
    expect(leadResult.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "<D> xcom -com acom .co m\r\n" +
        "end. end, endx end- the end\n" +
        "tail <D> end.",
    );

    // Trailing edge on the same fixture: only the two "end." spellings move.
    await writeFile(file, original);
    const trailResult = await ashlrSearchReplaceRegex({
      pattern: "end\\.",
      replacement: "<E>",
      roots: [file],
    });
    expect(trailResult.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      ".com xcom -com acom .co m\r\n" +
        "<E> end, endx end- the end\n" +
        "tail .com <E>",
    );

    // The pure in-memory transform consumes exactly the dotted bytes at
    // each edge — nothing on either side of them.
    expect(applyRegex("a .com xcom\n", /\.com/g, "D", 100)).toEqual({
      updated: "a D xcom\n",
      count: 1,
      capped: false,
    });
    expect(applyRegex("end. end, endx\n", /end\./g, "E", 100)).toEqual({
      updated: "E end, endx\n",
      count: 1,
      capped: false,
    });
  });

  test("a `.` in the replacement is inserted literally beside untouched periods", async () => {
    const file = join(tmpProj, "period-replacement.txt");
    // `.` carries no special meaning in a JS replacement string, so each
    // inserted period must land verbatim — beside the two pre-existing
    // periods in "b..c" that the pattern never touched.
    const original = "a POW b..c POW end\n";
    const expected = "a . b..c . end\n";
    await writeFile(file, original);

    const args = { pattern: "POW", replacement: ".", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Two inserted periods plus the two originals in "b..c" — no more.
    expect(after.split(".").length - 1).toBe(4);

    // The pure in-memory transform inserts the same verbatim period.
    const pure = applyRegex("x POW y\n", /POW/g, ".", 100);
    expect(pure).toEqual({ updated: "x . y\n", count: 1, capped: false });
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

  test("a literal backslash inside a phrase matches exactly and preserves surrounding text", async () => {
    const file = join(tmpProj, "backslash-phrase.txt");
    const original = "before café left\\right after\r\nleft/right left∖right leftright\nleft\\right end";
    const expected = "before café FOUND after\r\nleft/right left∖right leftright\nFOUND end";
    await writeFile(file, original);
    const args = { pattern: "left\\\\right", replacement: "FOUND", roots: [file] };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("a literal backslash pair replaces only adjacent pairs through the tool handler", async () => {
    const file = join(tmpProj, "backslash-pairs.txt");
    const clean = join(tmpProj, "backslash-pairs-none.txt");
    const original = "single=\\ pair=\\\\ triple=\\\\\\\r\nslashes=// ∖∖ ＼＼\nend=\\\\";
    const expected = "single=\\ pair=<PAIR> triple=<PAIR>\\\r\nslashes=// ∖∖ ＼＼\nend=<PAIR>";
    const cleanBytes = Buffer.from("single=\\ / ∖ ＼\r\nuntouched\n", "utf-8");
    await writeFile(file, original);
    await writeFile(clean, cleanBytes);

    // Four regex backslashes match two adjacent literal backslashes.
    const args = { pattern: "\\\\\\\\", replacement: "<PAIR>", roots: [file, clean] };
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(clean)).toEqual(cleanBytes);

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 3 replacements");
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

  test("escaped brace text replaces only the exact braces, not a regex repetition", async () => {
    const file = join(tmpProj, "braces.txt");
    // `a\{3\}` must match the five characters "a{3}", never "aaa" (what the
    // unescaped `a{3}` quantifier would match). `\{\{name\}\}` must match
    // the template placeholder "{{name}}", not "{name}" or "name".
    const original = "a{3} aaa {{name}} {name} name\nlast a{3}\n";
    const expected = "X aaa Y {name} name\nlast X\n";
    await writeFile(file, original);

    const args = { pattern: "a\\{3\\}|\\{\\{name\\}\\}", roots: [file] };
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();

    // Two separate runs so each literal gets its own replacement.
    await tool!.handler({ pattern: "a\\{3\\}", replacement: "X", roots: [file] }, { env: {} });
    const res = await tool!.handler({ pattern: "\\{\\{name\\}\\}", replacement: "Y", roots: [file] }, { env: {} });
    expect(res.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);

    // Direct call: the alternation of both escaped literals hits exactly 3 spots.
    const { updated, count } = applyRegex(original, new RegExp(args.pattern, "g"), "_", 100);
    expect(count).toBe(3);
    expect(updated).toBe("_ aaa _ {name} name\nlast _\n");

    // Unescaped, `a{3}` is a quantifier: it matches "aaa" and leaves "a{3}".
    const unescaped = applyRegex(original, /a{3}/g, "_", 100);
    expect(unescaped.count).toBe(1);
    expect(unescaped.updated).toContain("a{3}");
  });

  test("escaped brackets match a literal pair, never the characters a class reading would hit", async () => {
    const file = join(tmpProj, "brackets.txt");
    const classOnly = join(tmpProj, "brackets-class-only.txt");
    // `\[foo\]` must match the five characters "[foo]" and nothing else.
    // Unescaped, `[foo]` is a character class that matches a lone "f" or
    // "o" — so the bare "foo", "of" and "off" tokens (built only from
    // class members) must survive byte-for-byte, as must the bracket
    // look-alikes "[f]" and "[fo]" (different contents), "[foo foo]"
    // (a space breaks the pair) and "]foo[" (reversed). café and the
    // CRLF prove no byte beside a match was consumed. The second file
    // holds only class members — f's and o's — so a class reading would
    // rewrite it; under the literal it never enters the candidate set.
    const original =
      "[foo] of off foo [f] [fo] café\r\n" +
      "[foo foo] ]foo[ keep\n" +
      "last [foo]";
    const expected =
      "R of off foo [f] [fo] café\r\n" +
      "[foo foo] ]foo[ keep\n" +
      "last R";
    const classOnlyBytes = Buffer.from("f o oo of off\n", "utf-8");
    await writeFile(file, original);
    await writeFile(classOnly, classOnlyBytes);

    const args = { pattern: "\\[foo\\]", replacement: "R" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(classOnly)).toEqual(classOnlyBytes);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(classOnly)).toEqual(classOnlyBytes);

    // Assert each line individually so a mangled look-alike can't hide
    // inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("R of off foo [f] [fo] café\r");
    expect(lines[1]).toBe("[foo foo] ]foo[ keep");
    expect(lines[2]).toBe("last R");

    // Pure path: the escaped pair hits exactly the two literals, while
    // the same text under the unescaped class `[foo]` rewrites every
    // member byte — proving the escapes are what glued the pair shut.
    const { updated, count } = applyRegex(original, /\[foo\]/g, "R", 100);
    expect(count).toBe(2);
    expect(updated).toBe(expected);
    const asClass = applyRegex(original, /[foo]/g, "_", 100);
    expect(asClass.count).toBeGreaterThan(2);
    expect(asClass.updated).not.toContain("[foo]");

    // Same through the tool handler (JSON args path) — the escaped
    // brackets must survive transport and still match literally.
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

  test("literal $1 result holds exactly the two characters U+0024 U+0031, not the captured group", async () => {
    const file = join(tmpProj, "literal-dollar-one-chars.txt");
    // The captured group is "7", so a wrongly expanded `$1` would put
    // a 7 on disk; the literal must be `$` then `1` and nothing else.
    await writeFile(file, "id=7");

    const result = await ashlrSearchReplaceRegex({ pattern: "id=(\\d)", replacement: "$$1", roots: [file] });
    expect(result.text).toContain("1 file, 1 replacement");
    const after = await readFile(file, "utf-8");
    expect(after).toBe("$1");
    expect(after).toHaveLength(2);
    expect([...after].map((c) => c.codePointAt(0))).toEqual([0x24, 0x31]);
    expect(after).not.toContain("7");
  });

  test("literal replacement containing $1 lands verbatim when the pattern has no capture group", async () => {
    const file = join(tmpProj, "literal-dollar-one-groupless.txt");
    // With no group in the pattern, `$1` is out of range: GetSubstitution
    // only reads `$n` as a token when n <= the group count, so the two
    // characters `$1` land verbatim — the same bytes `$$1` escapes to,
    // without the escape. Engines that reject or blank an out-of-range
    // group reference (Python re.sub, Rust regex) would lose it; the
    // per-match walk delegates to native `replace`, which keeps it.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say a$1b tail\r\na$1b! café\nlast a$1b";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "a$1b", roots: [file] };
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

    // Pure path: the literal survives at every match width, alone or
    // wrapped, while the same replacement against a pattern WITH a
    // group still expands — the literal comes from the group count,
    // not the replacement text.
    const widths = applyRegex("n=1 n=22 n=333", /n=\d+/g, "[$1]", 100);
    expect(widths.count).toBe(3);
    expect(widths.updated).toBe("[$1] [$1] [$1]");
    expect(applyRegex("n=1", /n=\d+/g, "$1", 100).updated).toBe("$1");
    expect(applyRegex("n=1", /n=(\d+)/g, "[$1]", 100).updated).toBe("[1]");
  });

  test("literal replacement containing $1 lands verbatim beside an expanding capture-group token", async () => {
    const file = join(tmpProj, "literal-dollar-one-beside-token.txt");
    // `$$1` must yield the two characters `$1`; the adjacent bare `$1`
    // still expands to group 1. Keeping both in one replacement proves
    // the escape is honored without disabling the token: treating `$$1`
    // as the token would splice the captured digits in place of the
    // literal, and treating every `$` as escaped would leave the group
    // reference unexpanded. Three match widths — n=1, n=22, n=333 —
    // emit the identical two bytes `$1` while each expansion differs.
    const original = "say n=1 tail\r\nn=22! café\nlast n=333";
    const expected = "say $1=1 tail\r\n$1=22! café\nlast $1=333";
    await writeFile(file, original);

    const args = { pattern: "n=(\\d+)", replacement: "$$1=$1", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // Three sites each hold the identical two-byte literal; the only
    // surviving digits come from the expanding token.
    expect(after.split("$1=").length - 1).toBe(3);

    // Pure path: the same literal lands at every match width, and a
    // lone `$$1` emits exactly `$1` with the group reference suppressed.
    const pure = applyRegex(original, /n=(\d+)/g, "$$1=$1", 100);
    expect(pure.count).toBe(3);
    expect(pure.capped).toBe(false);
    expect(pure.updated).toBe(expected);
    expect(applyRegex("n=7", /n=(\d+)/g, "$$1", 100).updated).toBe("$1");

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
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

  test("literal replacement containing $$ keeps both dollar signs at every width, via the pure path and a capture group", async () => {
    // Pure path: `$$$$` is two literal dollars per site, whatever the
    // match width; a bare `$$` is the single-dollar escape.
    const original = "n=1 n=22 n=333";
    const pair = applyRegex(original, /n=\d+/g, "$$$$", 100);
    expect(pair.count).toBe(3);
    expect(pair.updated).toBe("$$ $$ $$");
    expect(applyRegex(original, /n=\d+/g, "$$", 100).updated).toBe("$ $ $");

    // Both dollars land literally before an expanding capture group.
    const grouped = applyRegex(original, /n=(\d+)/g, "$$$$$1", 100);
    expect(grouped.updated).toBe("$$1 $$22 $$333");

    // On disk, byte-for-byte, with a dry run that writes nothing.
    const file = join(tmpProj, "literal-dollar-pair-widths.txt");
    await writeFile(file, original);
    const args = { pattern: "n=(\\d+)", replacement: "$$$$$1", roots: [file] };
    const dry = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dry.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);
    await ashlrSearchReplaceRegex(args);
    const after = await readFile(file, "utf-8");
    expect(after).toBe("$$1 $$22 $$333");
    expect(after.split("$$").length - 1).toBe(3);
  });

  test("literal replacement containing $` lands the dollar sign and backtick verbatim via $$`", async () => {
    const file = join(tmpProj, "literal-dollar-backtick.txt");
    // `` $` `` is JS's "text before the match" token; `` $$` `` must yield
    // the two characters `` $` ``. The text before each marker ("say ",
    // "\r\n", "last ") must not be spliced in.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say it's $`ok tail\r\nit's $`ok! café\nlast it's $`ok";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "it's $$`ok", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // A replacement that is only the escaped pair emits exactly `$` + backtick.
    await writeFile(file, original);
    const only = await ashlrSearchReplaceRegex({ ...args, replacement: "$$`" });
    expect(only.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("say $` tail\r\n$`! café\nlast $`");

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("literal replacement containing $` survives the pure path and an adjacent expanding token", () => {
    const original = "n=1 n=22";
    // `$$`` → literal `$` + backtick, whatever the match width.
    const pure = applyRegex(original, /n=\d+/g, "$$`", 100);
    expect(pure.count).toBe(2);
    expect(pure.updated).toBe("$` $`");

    // Beside a capture group the literal pair stays put and `$1` still expands.
    const grouped = applyRegex(original, /n=(\d+)/g, "$$`$1", 100);
    expect(grouped.updated).toBe("$`1 $`22");

    // A bare `` $` `` is the expanding token: it inserts the text before the
    // match inside the matched span (empty), so no `$` or backtick survives.
    const bare = applyRegex(original, /n=\d+/g, "[$`]", 100);
    expect(bare.updated).toBe("[] []");
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

  test("a capped literal-dollar search replaces only the first dollars without rescanning replacement text", async () => {
    const file = join(tmpProj, "capped-literal-dollar.txt");
    const original = "$a $$ b$\r\n＄ end$";
    const expected = "[$]a [$][$] b$\r\n＄ end$";
    await writeFile(file, original);
    const args = { pattern: "\\$", replacement: "[$&]", roots: [file], maxMatchesPerFile: 3 };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected));
  });

  test("a literal dollar-sign search wraps each match in brackets — `[$&]` lands only around U+0024", async () => {
    const file = join(tmpProj, "literal-dollar-wrap.txt");
    // `[$&]` brackets whatever the pattern matched. If `\$` consumed even
    // one byte beyond the dollar sign, the brackets would surround more
    // than a lone "$". Dollars at offset 0, mid-token, adjacent and at
    // line end all wrap; the full-width ＄ (U+FF04) and dollar-free text
    // stay byte-identical.
    const original = "$a x$y$z $$ end$\n＄5 no money\nlast$";
    const expected = "[$]a x[$]y[$]z [$][$] end[$]\n＄5 no money\nlast[$]";
    await writeFile(file, original);

    const args = { pattern: "\\$", replacement: "[$&]", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file, "utf-8")).toBe(expected);

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a literal dollar-sign search replaces only the `$` byte, even beside dollar-token text", async () => {
    const file = join(tmpProj, "literal-dollar-token-neighbors.txt");
    // The file holds text that LOOKS like JS replacement tokens — `$&`,
    // `$'`, `$1`, `` $` `` — but the pattern side sees only data bytes: each
    // match is exactly one `$`, so the `&`, `'`, `1` and `` ` `` that
    // follow survive untouched. Dollars before a CRLF and at EOF (no
    // trailing newline) match too, while the look-alikes ＄ (U+FF04),
    // ﹩ (U+FE69) and ¤ (U+00A4) stay byte-identical.
    const original = "$& $' $1 $` a$b\r\nrow$\r\n＄ ﹩ ¤ end$";
    const expected = "<$>& <$>' <$>1 <$>` a<$>b\r\nrow<$>\r\n＄ ﹩ ¤ end<$>";
    await writeFile(file, original);

    // `<$&>` wraps the whole match in `<>`. If `\$` consumed even one byte
    // beyond the dollar sign, the angle brackets would surround more than
    // a lone `$`.
    const args = { pattern: "\\$", replacement: "<$&>", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 7 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 7 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file, "utf-8")).toBe(expected);

    // The same literal spelled `\x24` or `\u0024` matches the identical
    // U+0024 set — run under the m flag, where a misread end-anchor would
    // also fire before each `\r\n`.
    for (const spelling of ["\\x24", "\\u0024"]) {
      await writeFile(file, original);
      const res = await ashlrSearchReplaceRegex({
        pattern: spelling,
        replacement: "#",
        roots: [file],
        flags: "m",
      });
      expect(res.text).toContain("1 file, 7 replacements");
      expect(await readFile(file, "utf-8")).toBe(
        "#& #' #1 #` a#b\r\nrow#\r\n＄ ﹩ ¤ end#",
      );
    }

    // Same through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a literal dollar search beside regex metacharacters (`\\$\\{`, `\\$\\(`, `\\$HOME`) matches only the whole literal and preserves surrounding text", async () => {
    const file = join(tmpProj, "literal-dollar-metachars.txt");
    // Shell / template syntax: every `$` is followed by a regex-special
    // character. Escaped, each pattern is plain data; unescaped look-alikes
    // (`{x}`, `(x)`, `HOME` without a dollar, ＄ U+FF04) must not match.
    const original = "a=${NAME}/b $(pwd) $HOME {NAME} (pwd) HOME ＄{NAME} end$\n";
    await writeFile(file, original);

    const cases: Array<[string, string, string, number]> = [
      ["\\$\\{NAME\\}", "<$&>", "a=<${NAME}>/b $(pwd) $HOME {NAME} (pwd) HOME ＄{NAME} end$\n", 1],
      ["\\$\\(pwd\\)", "X", "a=${NAME}/b X $HOME {NAME} (pwd) HOME ＄{NAME} end$\n", 1],
      ["\\$HOME", "~", "a=${NAME}/b $(pwd) ~ {NAME} (pwd) HOME ＄{NAME} end$\n", 1],
      ["[$][{(]", "#", "a=#NAME}/b #pwd) $HOME {NAME} (pwd) HOME ＄{NAME} end$\n", 2],
    ];
    for (const [pattern, replacement, expected, n] of cases) {
      await writeFile(file, original);
      const args = { pattern, replacement, roots: [file] };

      const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
      expect(dryRun.text).toContain(`1 file, ${n} replacement`);
      expect(await readFile(file, "utf-8")).toBe(original);

      const result = await ashlrSearchReplaceRegex(args);
      expect(result.text).toContain(`1 file, ${n} replacement`);
      expect(await readFile(file, "utf-8")).toBe(expected);
    }

    // Pure path, and through the tool handler.
    expect(applyRegex("${A} ${B}", /\$\{/g, "$$", 100).updated).toBe("$A} $B}");
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    const viaTool = await tool!.handler(
      { pattern: "\\$\\{NAME\\}", replacement: "$$&", roots: [file] },
      { env: {} },
    );
    expect(viaTool.isError).not.toBe(true);
    expect(await readFile(file, "utf-8")).toBe(
      "a=$&/b $(pwd) $HOME {NAME} (pwd) HOME ＄{NAME} end$\n",
    );
  });

  test("a literal dollar-sign search under the m flag hits only U+0024 — dollar-free line ends and a dollar-free file stay inert", async () => {
    const file = join(tmpProj, "literal-dollar-m-flag.txt");
    const free = join(tmpProj, "dollar-free-m-flag.txt");
    // The m flag is where a misread `$` end anchor would hurt most: it
    // would fire at EVERY line end — before each `\n` and `\r\n` and at
    // EOF — so an anchor reading would also insert `<…>` after "plain ＄"
    // and inside the dollar-free file. Literal reading: only the five
    // U+0024 bytes match — at offset 0, mid-token, before an LF, before
    // a CRLF and at EOF with no trailing newline — while the fullwidth
    // ＄ (U+FF04) and every dollar-free line end stay inert.
    const original = "$a b$c end$\nplain ＄ win$\r\neof$";
    const expected = "<$>a b<$>c end<$>\nplain ＄ win<$>\r\neof<$>";
    const freeText = "alpha\nbeta\r\ngamma";
    await writeFile(file, original);
    await writeFile(free, freeText);

    const args = { pattern: "\\$", replacement: "<$&>", roots: [file, free], flags: "m" };

    // The pure planner prices only the file holding real dollars; an
    // anchor reading would also count the dollar-free file's line ends.
    const plan = await planSearchReplaceRegex(args);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.plan.files.length).toBe(1);
      expect(plan.plan.files[0]?.matches).toBe(5);
      expect(plan.plan.files[0]?.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    }

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(free)).toEqual(Buffer.from(freeText, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(free)).toEqual(Buffer.from(freeText, "utf-8"));

    // Same literal under m through the pure applyRegex path — `<$&>`
    // brackets whatever matched, so a zero-width anchor hit would leave
    // a `<>`-wrapped empty span at a dollar-free line end.
    const pure = applyRegex(original, /\$/gm, "<$&>", 100);
    expect(pure).toEqual({ updated: expected, count: 5, capped: false });
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

  test("a single backslash replacement survives adjacent matches and existing backslashes on disk", async () => {
    const file = join(tmpProj, "single-backslash-replacement.txt");
    const original = "MARKMARK\nleft\\MARK\\right\r\nMARK";
    const expected = "\\\\\nleft\\\\\\right\r\n\\";
    await writeFile(file, original);
    const args = { pattern: "MARK", replacement: "\\", roots: [file] };

    const preview = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(preview.text).toContain("1 file, 4 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 4 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original));
    expect(result.newBytes).toBe(Buffer.byteLength(expected));
    expect(await readFile(file)).toEqual(Buffer.from(expected));
  });

  test("backslash replacement beside a `$1` group token keeps the backslash and prices bytes per file", async () => {
    const a = join(tmpProj, "backslash-group-a.txt");
    const b = join(tmpProj, "backslash-group-b.txt");
    const origA = "id=abc\nid=de\n";
    const origB = "id=f\n";
    // `\\$1\` keeps both backslashes around the expanded capture group.
    const replacement = "<\\$1\\>";
    await writeFile(a, origA);
    await writeFile(b, origB);

    const result = await ashlrSearchReplaceRegex({ pattern: "id=(\\w+)", replacement, roots: [a, b] });
    expect(result.text).toContain("2 files, 3 replacements");
    const expA = "<\\abc\\>\n<\\de\\>\n";
    const expB = "<\\f\\>\n";
    expect(await readFile(a, "utf-8")).toBe(expA);
    expect(await readFile(b, "utf-8")).toBe(expB);
    expect(result.newBytes).toBe(Buffer.byteLength(expA + expB, "utf-8"));
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

  test("tool: literal newline replacement lands exactly at each match position", async () => {
    const file = join(tmpProj, "newline-positions.txt");
    // Matches sit at file start, mid-line, right before a CRLF and at EOF
    // (no trailing newline). Each is swapped for a single real LF; the
    // CRLF and café neighbors must be untouched.
    const original = "SEP head\nmid SEP tail café\r\nSEP\r\nend SEP";
    const expected = "\n head\nmid \n tail café\r\n\n\r\nend \n";
    await writeFile(file, original);

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const args = { pattern: "SEP", replacement: "\n", roots: [file] };
    const dryRun = await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(dryRun.isError).not.toBe(true);
    expect(dryRun.content[0]?.text).toContain("1 file, 4 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await tool!.handler(args, { env: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("1 file, 4 replacements");

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    // The newline replaces the match in place: text before and after each
    // site is unchanged, and no `\\n` text sequence was written.
    const text = after.toString("utf-8");
    expect(text.startsWith("\n head\n")).toBe(true);
    expect(text.endsWith("end \n")).toBe(true);
    expect(text).not.toContain("SEP");
    expect(text.includes("\\n")).toBe(false);
    expect(after.filter((b) => b === 0x0d).length).toBe(2);
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

  test("a replacement made of leading, doubled and trailing tabs keeps every 0x09 byte, never collapsed or trimmed", async () => {
    const file = join(tmpProj, "tab-edges.txt");
    const replacement = "\t\tid\t";
    await writeFile(file, "[X]\n[X][X]\n");

    const dryRun = await ashlrSearchReplaceRegex({ pattern: "X", replacement, roots: [file], dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");

    await ashlrSearchReplaceRegex({ pattern: "X", replacement, roots: [file] });
    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(`[${replacement}]\n[${replacement}][${replacement}]\n`, "utf-8"));
    expect(after.filter((b) => b === 0x09).length).toBe(9);
    expect(after.includes(Buffer.from("  "))).toBe(false);
  });

  test("a literal replacement containing a tab amid ordinary text keeps the 0x09 byte unchanged", async () => {
    const file = join(tmpProj, "tab-embedded.txt");
    // The tab sits between ordinary replacement characters. It must land
    // as a real 0x09 — never the two-character text "\t", never expanded
    // to spaces.
    const replacement = "key:\tvalue";
    const original = "a X b\nX X\n";
    const expected = `a ${replacement} b\n${replacement} ${replacement}\n`;
    await writeFile(file, original);

    const args = { pattern: "X", replacement, roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file);
    expect(after).toEqual(Buffer.from(expected, "utf-8"));
    // Three real tabs, no backslash-t text.
    expect(after.filter((b) => b === 0x09).length).toBe(3);
    expect(after.includes(Buffer.from("\\t"))).toBe(false);
    expect(after.toString("utf-8").split(replacement).length - 1).toBe(3);

    // Same replacement through the pure applyRegex path.
    const pure = applyRegex("a X b X\n", /X/g, replacement, 100);
    expect(pure.count).toBe(2);
    expect(pure.updated).toBe(`a ${replacement} b ${replacement}\n`);

    // And through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    await tool!.handler(args, { env: {} });
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
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

  test("a capped Unicode replacement preserves adjacent matches and CRLF bytes", async () => {
    const file = join(tmpProj, "unicode-capped.txt");
    const original = "前 MARKMARK\r\nkeep MARK café";
    const replacement = "e\u0301 🧑‍💻";
    const expected = "前 e\u0301 🧑‍💻MARK\r\nkeep MARK café";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement, roots: [file], maxMatchesPerFile: 1 };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(dryRun.text).toContain("cap hit");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(result.text).toContain("cap hit");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
  });

  test("Unicode replacement containing the search literal is not rescanned", async () => {
    const file = join(tmpProj, "unicode-no-rescan.txt");
    const original = "MARKMARK\r\nend MARK";
    const replacement = "é/e\u0301-MARK-👩🏽‍🚀";
    const expected = "é/e\u0301-MARK-👩🏽‍🚀é/e\u0301-MARK-👩🏽‍🚀\r\nend é/e\u0301-MARK-👩🏽‍🚀";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement, roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
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

  test("a literal is replaced only in its exact case among all eight permutations — standalone, embedded and at EOF — while the i flag rewrites every spelling", async () => {
    const file = join(tmpProj, "literal-permutations.txt");
    const offCaseOnly = join(tmpProj, "literal-permutations-off.txt");
    // "TaG" has eight case spellings; line 1 holds all of them and only
    // the exact spelling may move. Line 2 embeds the exact spelling
    // inside longer tokens ("xTaG", "TaGxx", "preTaGpost") beside hosts
    // carrying off-case spellings ("xTAGx", "taGend") — the match must
    // consume exactly the three exact-case bytes wherever it sits. Line
    // 3 is an unterminated EOF occurrence. The second file holds only
    // off-case spellings, so rg never surfaces it as a candidate.
    const original =
      "tag taG tAg tAG Tag TaG TAg TAG café\r\n" +
      "xTaG TaGxx preTaGpost xTAGx taGend\n" +
      "tail TaG";
    const expected =
      "tag taG tAg tAG Tag Hit TAg TAG café\r\n" +
      "xHit Hitxx preHitpost xTAGx taGend\n" +
      "tail Hit";
    const offOriginal = Buffer.from("tag tAg TAG taGend\n", "utf-8");
    await writeFile(file, original);
    await writeFile(offCaseOnly, offOriginal);

    const args = { pattern: "TaG", replacement: "Hit" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readFile(offCaseOnly)).toEqual(offOriginal);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 5 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(offCaseOnly)).toEqual(offOriginal);

    // Assert each line individually so a mangled off-case spelling can't
    // hide inside a whole-file comparison.
    const lines = (await readFile(file, "utf-8")).split("\n");
    expect(lines[0]).toBe("tag taG tAg tAG Tag Hit TAg TAG café\r");
    expect(lines[1]).toBe("xHit Hitxx preHitpost xTAGx taGend");
    expect(lines[2]).toBe("tail Hit");

    // The pure in-memory transform sees the same case-sensitive split.
    const { updated, count } = applyRegex(original, /TaG/g, "Hit", 100);
    expect(count).toBe(5);
    expect(updated).toBe(expected);

    // Same search through the tool handler (JSON args path).
    await writeFile(file, original);
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(args, { env: {} });
    expect(viaTool.isError).not.toBe(true);
    expect(viaTool.content[0]?.text).toContain("1 file, 5 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    expect(await readFile(offCaseOnly)).toEqual(offOriginal);

    // Control: the same fixture under the i flag rewrites all fourteen
    // spellings here plus the four in the off-case file, which now enters
    // the candidate set — proof the earlier survival was case alone.
    await writeFile(file, original);
    const insensitive = await ashlrSearchReplaceRegex({ ...args, flags: "i" });
    expect(insensitive.text).toContain("2 files, 18 replacements");
    expect(await readFile(file)).toEqual(
      Buffer.from(
        "Hit Hit Hit Hit Hit Hit Hit Hit café\r\n" +
          "xHit Hitxx preHitpost xHitx Hitend\n" +
          "tail Hit",
        "utf-8",
      ),
    );
    expect(await readFile(offCaseOnly)).toEqual(Buffer.from("Hit Hit Hit Hitend\n", "utf-8"));
  });

  test("a non-ASCII literal is case-sensitive too; the i flag opts in to other casings", async () => {
    const file = join(tmpProj, "literal-case-unicode.txt");
    const offCaseOnly = join(tmpProj, "literal-case-unicode-off.txt");
    // "Éclair" starts with a non-ASCII capital. "éclair" / "ÉCLAIR" /
    // "eclair" must stay byte-identical without the i flag.
    const original = "Éclair éclair ÉCLAIR eclair Éclair\n";
    const offOriginal = Buffer.from("éclair ÉCLAIR eclair\n", "utf-8");
    await writeFile(file, original);
    await writeFile(offCaseOnly, offOriginal);

    const result = await ashlrSearchReplaceRegex({ pattern: "Éclair", replacement: "Tart" });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("Tart éclair ÉCLAIR eclair Tart\n");
    expect(await readFile(offCaseOnly)).toEqual(offOriginal);

    // Opting in with `i` rewrites the other accented casings, but never
    // the unaccented "eclair" (a different letter, not a different case).
    await writeFile(file, original);
    await ashlrSearchReplaceRegex({ pattern: "Éclair", replacement: "Tart", flags: "i" });
    expect(await readFile(file, "utf-8")).toBe("Tart Tart Tart eclair Tart\n");
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

  test("a bare `+` (nothing to repeat) is refused as invalid regex, leaving pluses untouched", async () => {
    const file = join(tmpProj, "unescaped-plus.txt");
    // A lone `+` is a quantifier with nothing to its left — JS throws
    // "nothing to repeat" (and rg would exit 2) — so a literal-plus
    // search MUST be written `\+` or `[+]`. The refusal fires at
    // compile time, before any file is scanned; the file's real pluses
    // prove nothing was rewritten in the attempt.
    const original = Buffer.from("1+1 a++b café +\n", "utf-8");
    await writeFile(file, original);

    const args = { pattern: "+", replacement: "P", roots: [file] };
    const plan = await planSearchReplaceRegex(args);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/invalid regex/i);
    await expect(ashlrSearchReplaceRegex(args)).rejects.toThrow(/invalid regex/i);
    expect(await readFile(file)).toEqual(original);

    // The tool handler reports the same refusal on the JSON args path,
    // in apply and dry run alike — the refusal precedes planning.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dryRun of [false, true]) {
      const viaTool = await tool!.handler({ ...args, dryRun }, { env: {} });
      expect(viaTool.isError).toBe(true);
      expect(viaTool.content[0]?.text).toMatch(/invalid regex/i);
    }
    expect(await readFile(file)).toEqual(original);
  });

  test("a bare `?` or `??` (nothing to repeat) is refused as invalid regex, leaving marks untouched", async () => {
    const file = join(tmpProj, "unescaped-question.txt");
    // A lone `?` is a quantifier with nothing to its left — and `??`
    // tries to lazy-modify that same nothing — so JS throws "nothing to
    // repeat" (and rg would exit 2). A literal question-mark search
    // MUST be written `\?` or `[?]`. The refusal fires at compile time,
    // before any file is scanned; the file's real marks prove nothing
    // was rewritten in the attempt.
    const original = Buffer.from("why? a? really?? café\n", "utf-8");
    await writeFile(file, original);

    for (const pattern of ["?", "??"]) {
      const args = { pattern, replacement: "X", roots: [file] };
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toMatch(/invalid regex/i);
      await expect(ashlrSearchReplaceRegex(args)).rejects.toThrow(/invalid regex/i);
      expect(await readFile(file)).toEqual(original);
    }

    // The tool handler reports the same refusal on the JSON args path,
    // in apply and dry run alike — the refusal precedes planning.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dryRun of [false, true]) {
      const viaTool = await tool!.handler(
        { pattern: "?", replacement: "X", roots: [file], dryRun },
        { env: {} },
      );
      expect(viaTool.isError).toBe(true);
      expect(viaTool.content[0]?.text).toMatch(/invalid regex/i);
    }
    expect(await readFile(file)).toEqual(original);
  });

  test("a bare `*` or `**` (nothing to repeat) is refused as invalid regex, leaving stars untouched", async () => {
    const file = join(tmpProj, "unescaped-asterisk.txt");
    // A lone `*` is a quantifier with nothing to its left — and `**`
    // tries to repeat that same nothing — so JS throws "nothing to
    // repeat" (and rg would exit 2). A literal asterisk search MUST be
    // written `\*` or `[*]`. The refusal fires at compile time, before
    // any file is scanned; the file's real stars prove nothing was
    // rewritten in the attempt.
    const original = Buffer.from("a*b 1*2 ** ＊ café\n", "utf-8");
    await writeFile(file, original);

    for (const pattern of ["*", "**"]) {
      const args = { pattern, replacement: "X", roots: [file] };
      const plan = await planSearchReplaceRegex(args);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toMatch(/invalid regex/i);
      await expect(ashlrSearchReplaceRegex(args)).rejects.toThrow(/invalid regex/i);
      expect(await readFile(file)).toEqual(original);
    }

    // The tool handler reports the same refusal on the JSON args path,
    // in apply and dry run alike — the refusal precedes planning.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    for (const dryRun of [false, true]) {
      const viaTool = await tool!.handler(
        { pattern: "*", replacement: "X", roots: [file], dryRun },
        { env: {} },
      );
      expect(viaTool.isError).toBe(true);
      expect(viaTool.content[0]?.text).toMatch(/invalid regex/i);
    }
    expect(await readFile(file)).toEqual(original);
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

  test("a bare `^` or `^^` (start anchors alone) is refused as zero-width, leaving carets untouched", async () => {
    const file = join(tmpProj, "unescaped-caret.txt");
    // A bare `^` anchors at start-of-line/input — it never consumes a
    // character, so a literal caret search MUST be written `\^` or
    // `[\^]`. The tool refuses rather than inserting at every line
    // start; `^^` (two anchors) is zero-width too, and the m flag only
    // multiplies the anchor positions. The file's real carets prove
    // nothing was rewritten in the attempt.
    const original = Buffer.from("a^b keep café ^x end^\n", "utf-8");
    await writeFile(file, original);

    for (const args of [
      { pattern: "^", replacement: "X" },
      { pattern: "^", replacement: "X", flags: "m" },
      { pattern: "^^", replacement: "X" },
      { pattern: "^^", replacement: "X", flags: "m" },
    ]) {
      await expect(
        ashlrSearchReplaceRegex({ ...args, roots: [file] }),
      ).rejects.toThrow(/zero-width/);
    }
    expect(await readFile(file)).toEqual(original);

    // The tool handler reports the same refusal on the JSON args path.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(
      { pattern: "^", replacement: "X", roots: [file] },
      { env: {} },
    );
    expect(viaTool.isError).toBe(true);
    expect(viaTool.content[0]?.text).toContain("zero-width");
    expect(await readFile(file)).toEqual(original);
  });

  test("a bare `$` or `$$` (end anchors alone) is refused as zero-width, leaving dollars untouched", async () => {
    const file = join(tmpProj, "unescaped-dollar.txt");
    // A bare `$` anchors at end-of-line/input — it never consumes a
    // character, so a literal dollar-sign search MUST be written `\$` or
    // `[$]`. The tool refuses rather than inserting at every line end;
    // `$$` (two anchors) is zero-width too, and the m flag only multiplies
    // the anchor positions. The file's real dollars prove nothing was
    // rewritten in the attempt.
    const original = Buffer.from("a$ keep café $5 end$\n", "utf-8");
    await writeFile(file, original);

    for (const args of [
      { pattern: "$", replacement: "X" },
      { pattern: "$", replacement: "X", flags: "m" },
      { pattern: "$$", replacement: "X" },
    ]) {
      await expect(
        ashlrSearchReplaceRegex({ ...args, roots: [file] }),
      ).rejects.toThrow(/zero-width/);
    }
    expect(await readFile(file)).toEqual(original);

    // The tool handler reports the same refusal on the JSON args path.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(
      { pattern: "$", replacement: "X", roots: [file] },
      { env: {} },
    );
    expect(viaTool.isError).toBe(true);
    expect(viaTool.content[0]?.text).toContain("zero-width");
    expect(await readFile(file)).toEqual(original);
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

  test("an optional-only `?` pattern that also matches empty is refused as zero-width, leaving marks untouched", async () => {
    const file = join(tmpProj, "optional-question.txt");
    // `a?` ("zero or one a") and `a??` (the lazy spelling) both accept
    // the empty string — the quantified atom can consume nothing — so
    // the pattern fires at every position and a literal question mark
    // can never be the intended target. The refusal fires before any
    // file is scanned; the file's real marks prove nothing was
    // rewritten in the attempt.
    const original = Buffer.from("a? b? why?? café\n", "utf-8");
    await writeFile(file, original);

    for (const pattern of ["a?", "a??"]) {
      await expect(
        ashlrSearchReplaceRegex({ pattern, replacement: "X", roots: [file] }),
      ).rejects.toThrow(/zero-width/);
    }
    expect(await readFile(file)).toEqual(original);

    // The tool handler reports the same refusal on the JSON args path.
    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    const viaTool = await tool!.handler(
      { pattern: "a?", replacement: "X", roots: [file] },
      { env: {} },
    );
    expect(viaTool.isError).toBe(true);
    expect(viaTool.content[0]?.text).toContain("zero-width");
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

  test("literal backslash search in applyRegex replaces only backslashes", () => {
    // `/\\/g` is one literal backslash. Slash look-alikes, `n`/`t` letters
    // and the newline must stay byte-identical.
    const text = "a\\b c/d ∖ ⧵ ＼ n t\n\\\\ end\\";
    const { updated, count, capped } = applyRegex(text, /\\/g, "|", 100);
    expect(count).toBe(4);
    expect(capped).toBe(false);
    expect(updated).toBe("a|b c/d ∖ ⧵ ＼ n t\n|| end|");
    expect(updated).not.toContain("\\");
  });

  test("two-backslash pattern in applyRegex matches only an adjacent pair", () => {
    // `/\\\\/g` is two literal backslashes: a lone `\` is left alone and a
    // run of three yields one pair match plus a leftover backslash.
    const { updated, count } = applyRegex("lone\\ pair\\\\ triple\\\\\\ end\n", /\\\\/g, "|", 100);
    expect(count).toBe(2);
    expect(updated).toBe("lone\\ pair| triple|\\ end\n");
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

  test("carriage return amid ordinary text is retained exactly through the tool handler, beside capture groups", async () => {
    const file = join(tmpProj, "cr-handler.txt");
    const original = "k1=v1\nk2=v2\r\nplain line\rlone cr\n";
    await writeFile(file, original);
    // `\r` mid-replacement, plus a CRLF pair; neither may become LF or the
    // two-character text `\r`.
    const args = { pattern: "(\\w+)=(\\w+)", replacement: "$1\r$2\r\n", roots: [file] };

    const tool = getTool("ashlr__search_replace_regex");
    expect(tool).toBeDefined();
    await tool!.handler({ ...args, dryRun: true }, { env: {} });
    expect(await readFile(file, "utf-8")).toBe(original);

    await tool!.handler(args, { env: {} });
    const after = await readFile(file);
    expect(after).toEqual(Buffer.from("k1\rv1\r\n\nk2\rv2\r\n\r\nplain line\rlone cr\n", "utf-8"));
    // 2 inserted lone CRs + 2 inserted CRLF CRs + 1 pre-existing CRLF CR
    // + 1 pre-existing lone CR.
    expect(after.filter((b) => b === 0x0d).length).toBe(6);
    expect(after.includes(Buffer.from("\\r"))).toBe(false);
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

  test("literal forward-slash search matches and replaces only U+002F", async () => {
    const file = join(tmpProj, "forward-slash.txt");
    // A bare `/` is a plain literal, not a regex delimiter. Look-alikes —
    // backslash, division slash (U+2215), fullwidth solidus (U+FF0F) — and
    // slash-free text must stay byte-identical.
    const original = "a/b c/d/e\nback\\slash\n∕ ／\nnone\n";
    const expected = "a-b c-d-e\nback\\slash\n∕ ／\nnone\n";
    await writeFile(file, original);
    const args = { pattern: "/", replacement: "-", roots: [file] };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Same literal through the pure path, and a slash replacement lands verbatim.
    const pure = applyRegex("a/b c/d/e\n", /\//g, "//", 100);
    expect(pure.count).toBe(3);
    expect(pure.updated).toBe("a//b c//d//e\n");
  });

  test("empty replacement deletes each match and keeps the text between them", () => {
    const { updated, count, capped } = applyRegex("a X b X c\n", /X/g, "", 100);
    expect(count).toBe(2);
    expect(capped).toBe(false);
    expect(updated).toBe("a  b  c\n");
  });

  test("literal replacement with leading and trailing spaces keeps both spaces", async () => {
    const file = join(tmpProj, "padded-replacement.txt");
    const original = "a=1\nb=2\n";
    const expected = "a  :  1\nb  :  2\n";
    await writeFile(file, original);
    const args = { pattern: "=", replacement: "  :  ", roots: [file] };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // One leading + one trailing space, via the pure path.
    const pure = applyRegex("x=y\n", /=/g, " + ", 100);
    expect(pure.count).toBe(1);
    expect(pure.updated).toBe("x + y\n");
  });
});

describe("literal tab search, pure path", () => {
  test("a tab-only and a multi-tab literal match exactly those tabs", () => {
    // Pattern is escaped the way the tool escapes a literal: tab stays a real 0x09.
    const text = "a\tb\t\tc\t\t\td\n";

    const single = applyRegex(text, /\t/g, "<T>", 100);
    expect(single.count).toBe(6);
    expect(single.updated).toBe("a<T>b<T><T>c<T><T><T>d\n");

    // "\t\t" consumes pairs left to right: the double tab once, the triple tab once
    // (its third tab is left over).
    const pair = applyRegex(text, /\t\t/g, "<TT>", 100);
    expect(pair.count).toBe(2);
    expect(pair.updated).toBe("a\tb<TT>c<TT>\td\n");

    // The two-character backslash-t text is not a tab.
    const escapedText = applyRegex("a\\tb\n", /\t/g, "<T>", 100);
    expect(escapedText.count).toBe(0);
    expect(escapedText.updated).toBe("a\\tb\n");
  });
});

describe("literal search with leading spaces, YAML-style list", () => {
  test("the leading spaces and the dash are matched together; other lines stay unchanged", async () => {
    const file = join(tmpProj, "list.yml");
    const original = "- top\n  - nested\n- top two\n    - deep\nnote: a  - b\n";
    // "  - " (two spaces, dash, space) matches inside "a  - b" and the
    // 4-space line too, but never the unindented "- top" lines.
    const expected = "- top\n* nested\n- top two\n  * deep\nnote: a* b\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({
      pattern: "  - ",
      replacement: "* ",
      roots: [file],
    });
    expect(result.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });
});

describe("literal search with a single leading space", () => {
  test("only the space-prefixed word is replaced; the same word without that space stays", async () => {
    const file = join(tmpProj, "single-leading-space.txt");
    const original = "cat\nconcat\n cat\n\tcat\nthe cat sat\n";
    // " cat" (one 0x20 byte) consumes its space: " cat" -> "dog", "the cat" -> "thedog".
    const expected = "cat\nconcat\ndog\n\tcat\nthedog sat\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({
      pattern: " cat",
      replacement: "dog",
      roots: [file],
    });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });
});

describe("literal search with a single trailing space", () => {
  test("only the space-suffixed word is replaced; the same word without that space stays", async () => {
    const file = join(tmpProj, "single-trailing-space.txt");
    const original = "cat\ncats\ncat \ncat\t\ncat sat\n";
    // "cat " (one 0x20 byte) consumes its space: "cat " -> "dog", "cat sat" -> "dogsat".
    // Unspaced "cat", "cats" and tab-suffixed "cat\t" stay byte-identical.
    const expected = "cat\ncats\ndog\ncat\t\ndogsat\n";
    await writeFile(file, original);

    const args = { pattern: "cat ", replacement: "dog", roots: [file] };
    expect(args.pattern.endsWith(" ")).toBe(true);

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("a file holding only unspaced look-alikes is left byte-identical", async () => {
    const file = join(tmpProj, "single-trailing-space-none.txt");
    const original = "cat\ncats\ncat\t\nconcat\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "cat ", replacement: "dog", roots: [file] });
    expect(result.text).toContain("0 files, 0 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
  });
});

describe("literal search beside a similar longer string", () => {
  test("a plain literal replaces every occurrence, including inside the longer string", async () => {
    const file = join(tmpProj, "words.txt");
    // Plain text is a literal: no word boundary is implied, so "cat" also
    // matches inside "concat" and "cats", while "dog" and "ca t" stay put.
    const original = "cat concat cats\ndog ca t\n";
    const expected = "DOG conDOG DOGs\ndog ca t\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({
      pattern: "cat",
      replacement: "DOG",
      roots: [file],
    });
    expect(result.text).toBe(
      "[ashlr__search_replace_regex] 1 file, 3 replacements\n" +
        `  ${file}: 3 matches\n` +
        "  1 file written, 3 total replacements",
    );
    expect(await readFile(file, "utf-8")).toBe(expected);
  });
});

describe("literal multiline search holding regex metacharacters", () => {
  test("an escaped literal spanning a newline replaces only the exact match and keeps neighbors", async () => {
    const file = join(tmpProj, "meta-multiline.txt");
    // `(`, `.`, `[` and `$` are escaped so they read as plain text. The
    // look-alikes — metacharacters swapped for other characters, or a blank
    // line between the halves — must stay byte-identical.
    const original =
      "head café\ncost (USD)\n$5.00 [net] tail\ncost (USD)\n$5x00 [net]\ncost (USD)\n\n$5.00 [net]\nfoot\n";
    const expected =
      "head café\nPRICE tail\ncost (USD)\n$5x00 [net]\ncost (USD)\n\n$5.00 [net]\nfoot\n";
    await writeFile(file, original);

    const args = {
      pattern: "cost \\(USD\\)\n\\$5\\.00 \\[net\\]",
      replacement: "PRICE",
      roots: [file],
    };

    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(original);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });
});

describe("literal parenthesis search, lone and nested parens", () => {
  test("a bare escaped paren pair replaces only real parens; look-alikes and other text stay", async () => {
    const file = join(tmpProj, "bare-parens.txt");
    // `\(` and `\)` alone hit only U+0028 / U+0029. Brackets, braces,
    // fullwidth （ ） and the plain word "paren" must stay byte-identical.
    const original = "call(a(b)) [x] {y} （z） paren\n";
    const expected = "call<a<b>> [x] {y} （z） paren\n";
    await writeFile(file, original);

    const open = await ashlrSearchReplaceRegex({ pattern: "\\(", replacement: "<", roots: [file] });
    expect(open.text).toContain("1 file, 2 replacements");
    const close = await ashlrSearchReplaceRegex({ pattern: "\\)", replacement: ">", roots: [file] });
    expect(close.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("an escaped nested group replaces the whole literal and leaves the unbalanced look-alike", async () => {
    const file = join(tmpProj, "nested-parens.txt");
    const original = "f(a(b)) f(a(b) f(ab) f(a(b))\n";
    const expected = "X f(a(b) f(ab) X\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({
      pattern: "f\\(a\\(b\\)\\)",
      replacement: "X",
      roots: [file],
    });
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(expected);
  });

  test("applyRegex with an escaped-paren regex matches literal parens only", () => {
    const { updated, count } = applyRegex("(a) a (b)\n", /\(a\)/g, "Z", 100);
    expect(count).toBe(1);
    expect(updated).toBe("Z a (b)\n");
  });
});
