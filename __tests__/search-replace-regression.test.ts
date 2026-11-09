/**
 * search-replace-regression.test.ts — literal pattern and replacement
 * edge cases (escaped metacharacters, `$` tokens, repeated matches).
 *
 * `replacement` follows JS String.replace semantics, so `$$` yields one
 * literal `$`, while a `$` that does not start a token (`$ `, `$USD`, a
 * trailing `$`) already passes through unchanged. Context tokens $` and
 * $' resolve against the match substring alone, never splicing the
 * file's prefix or suffix into the output. Each case asserts the
 * exact file bytes, in dry-run (untouched) and apply modes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
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

describe("literal dollar sign in replacement", () => {
  test("`$$` before a digit becomes one literal `$` (price rewrite)", async () => {
    const file = join(tmpProj, "price.txt");
    const original = "price: PRICE\n";
    await writeFile(file, original);

    const args = { pattern: "PRICE", replacement: "$$19.99" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("price: $19.99\n");
  });

  test("a `$` that starts no token stays literal, including a trailing `$`", async () => {
    const file = join(tmpProj, "plain.txt");
    await writeFile(file, "a=X\nb=X\n");

    await ashlrSearchReplaceRegex({ pattern: "X", replacement: "$USD $ end$" });
    expect(await readFile(file, "utf-8")).toBe("a=$USD $ end$\nb=$USD $ end$\n");
  });

  test("literal `$` coexists with a real capture reference", async () => {
    const file = join(tmpProj, "mixed.txt");
    await writeFile(file, "cost 5\n");

    await ashlrSearchReplaceRegex({ pattern: "cost (\\d+)", replacement: "$$$1 total" });
    expect(await readFile(file, "utf-8")).toBe("$5 total\n");
  });
});

describe("literal hyphen in pattern", () => {
  test("replaces only the exact hyphenated text", async () => {
    const file = join(tmpProj, "hyphen.txt");
    const untouched = join(tmpProj, "other.txt");
    const original = "well-known well known wellknown well--known well–known\r\nwell-known\n";
    const other = "well known well--known\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "well-known", replacement: "famous" };
    const dry = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dry.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);
    expect(await readFile(untouched, "utf-8")).toBe(other);

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("famous well known wellknown well--known well–known\r\nfamous\n");
    expect(await readFile(untouched, "utf-8")).toBe(other);
  });
});

describe("literal plus sign in pattern", () => {
  test("escaped `\\+` replaces only the exact `a+b`, not `aab` or `ab`", async () => {
    const file = join(tmpProj, "plus.txt");
    const original = "a+b aab ab a++b a+b\n";
    await writeFile(file, original);

    const args = { pattern: "a\\+b", replacement: "SUM" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("SUM aab ab a++b SUM\n");
  });
});

describe("literal pattern with no match", () => {
  test("an absent literal leaves the file unchanged and reports 0 files, 0 replacements", async () => {
    const file = join(tmpProj, "absent.txt");
    const original = "alpha beta\nprice: $5 (a+b)\n";
    await writeFile(file, original);

    // `\+` and `\$` are escaped so the pattern is a plain literal that is not in the file.
    const args = { pattern: "a\\+\\+b\\$", replacement: "SUM" };
    for (const dryRun of [true, false]) {
      const { text } = await ashlrSearchReplaceRegex({ ...args, dryRun });
      expect(text).toContain("0 files, 0 replacements");
      expect(await readFile(file, "utf-8")).toBe(original);
    }
  });

  test("a file without the literal stays byte-identical while a matching sibling is rewritten", async () => {
    const hit = join(tmpProj, "hits.txt");
    const miss = join(tmpProj, "miss.txt");
    // `a+`, `a++`, `a+b`, `aXb` all fall short of the full `a++b` needle, so
    // only the sibling matches and `miss.txt` never enters the plan.
    const missOriginal = Buffer.from("near misses: a+ a++ a+b aXb\r\ncafé\n", "utf-8");
    await writeFile(hit, "a++b and a++b\n");
    await writeFile(miss, missOriginal);

    const args = { pattern: "a\\+\\+b", replacement: "SUM" };

    const dry = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dry.text).toContain("1 file, 2 replacements");
    expect(dry.text).not.toContain("miss.txt");
    expect(await readFile(miss)).toEqual(missOriginal);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(hit, "utf-8")).toBe("SUM and SUM\n");
    expect(await readFile(miss)).toEqual(missOriginal);
  });
});

describe("literal question mark in pattern", () => {
  test("escaped `\\?` replaces only the exact `a?b`, not `ab` or `aab`", async () => {
    const file = join(tmpProj, "question.txt");
    const original = "a?b ab aab a??b a?b\n";
    await writeFile(file, original);

    const args = { pattern: "a\\?b", replacement: "ASK" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("ASK ab aab a??b ASK\n");
  });

  test("unescaped `?` is a quantifier, a `?` in a character class is literal", async () => {
    const file = join(tmpProj, "quantifier.txt");
    await writeFile(file, "a?b ab\n");

    const quantifier = await ashlrSearchReplaceRegex({ pattern: "a?b", replacement: "X", dryRun: true });
    expect(quantifier.text).toContain("1 file, 2 replacements");

    await ashlrSearchReplaceRegex({ pattern: "a[?]b", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT ab\n");
  });
});

describe("literal question mark leaves unrelated text unchanged", () => {
  test("a bare `\\?` rewrites only question marks; other text and files stay byte-identical", async () => {
    const file = join(tmpProj, "ask.txt");
    const untouched = join(tmpProj, "no-question.txt");
    const original = "why? what is a? ok.\r\nplain line: a b 1+1=2 café\r\nend??\n";
    const other = Buffer.from("no question marks: why. what\r\ncafé\n", "utf-8");
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "\\?", replacement: "!" };
    const dry = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dry.text).toContain("1 file, 4 replacements");
    expect(dry.text).not.toContain("no-question.txt");
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 4 replacements");
    expect(await readFile(file, "utf-8")).toBe("why! what is a! ok.\r\nplain line: a b 1+1=2 café\r\nend!!\n");
    expect(await readFile(untouched)).toEqual(other);
  });
});

describe("literal caret in pattern", () => {
  test("escaped `\\^` replaces only a text caret, not the line start", async () => {
    const file = join(tmpProj, "caret.txt");
    const original = "a^b\n2^8 x^y\nab\n";
    await writeFile(file, original);

    const args = { pattern: "\\^", replacement: "POW" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("aPOWb\n2POW8 xPOWy\nab\n");
  });

  test("a caret inside a character class is a literal, not an anchor", async () => {
    const file = join(tmpProj, "class.txt");
    await writeFile(file, "a^b ab\n");

    await ashlrSearchReplaceRegex({ pattern: "a[\\^]b", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT ab\n");
  });

  test("a caret-containing literal replaces only that exact text", async () => {
    const file = join(tmpProj, "exact.txt");
    const untouched = join(tmpProj, "untouched.txt");
    const original = "x^2 + y^2\nx2 xx2 X^2\n^x^2\n";
    const other = "no carets: x2\n";
    await writeFile(file, original);
    await writeFile(untouched, other);

    const args = { pattern: "x\\^2", replacement: "SQ" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    // `y^2`, `X^2`, the leading `^` and every caret-free `x2` survive.
    expect(await readFile(file, "utf-8")).toBe("SQ + y^2\nx2 xx2 X^2\n^SQ\n");
    expect(await readFile(untouched, "utf-8")).toBe(other);
  });

  test("an unescaped leading `^` is an anchor, not a text caret", async () => {
    const file = join(tmpProj, "anchor.txt");
    await writeFile(file, "a^b a\n^a\n");

    // Contrast case: without the `m` flag `^a` matches only at the file start,
    // so the `a` after the text caret and the `^a` on line 2 are untouched.
    const { text } = await ashlrSearchReplaceRegex({ pattern: "^a", replacement: "A" });
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("A^b a\n^a\n");
  });
});

describe("literal pipe in pattern", () => {
  test("escaped `\\|` replaces only the exact `a|b`, not `a` or `b` alone", async () => {
    const file = join(tmpProj, "pipe.txt");
    const original = "a|b a b ab a||b a|b\n";
    await writeFile(file, original);

    const args = { pattern: "a\\|b", replacement: "OR" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("OR a b ab a||b OR\n");
  });

  test("unescaped `|` stays alternation (contrast), so escaping is what makes it literal", async () => {
    const file = join(tmpProj, "alt.txt");
    await writeFile(file, "a|b a b\n");

    await ashlrSearchReplaceRegex({ pattern: "a|b", replacement: "X" });
    expect(await readFile(file, "utf-8")).toBe("X|X X X\n");
  });

  test("a pipe inside a character class is a literal, not an alternation", async () => {
    const file = join(tmpProj, "pipe-class.txt");
    await writeFile(file, "a|b a b\n");

    await ashlrSearchReplaceRegex({ pattern: "a[|]b", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT a b\n");
  });
});

describe("literal parentheses in pattern", () => {
  test("escaped `\\(` and `\\)` replace only the exact `(a+b)`, not bare `a+b`", async () => {
    const file = join(tmpProj, "paren.txt");
    const original = "f(a+b) a+b (a+b) f(a+b)x (a b)\n";
    await writeFile(file, original);

    const args = { pattern: "\\(a\\+b\\)", replacement: "SUM" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe("fSUM a+b SUM fSUMx (a b)\n");
  });

  test("unescaped parentheses are a capture group, parentheses in a class are literal", async () => {
    const file = join(tmpProj, "paren-class.txt");
    await writeFile(file, "(x) x\n");

    // Contrast case: `(x)` as a group matches both bare `x` and the `x` in `(x)`.
    const group = await ashlrSearchReplaceRegex({ pattern: "(x)", replacement: "Y", dryRun: true });
    expect(group.text).toContain("1 file, 2 replacements");

    await ashlrSearchReplaceRegex({ pattern: "[(]x[)]", replacement: "HIT" });
    expect(await readFile(file, "utf-8")).toBe("HIT x\n");
  });
});

describe("repeated literal match", () => {
  test("back-to-back occurrences of the same literal each get replaced", async () => {
    const file = join(tmpProj, "repeat.txt");
    const original = "foofoofoo and foo\n";
    await writeFile(file, original);

    const args = { pattern: "foo", replacement: "baz" };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 4 replacements");
    expect(await readFile(file, "utf-8")).toBe("bazbazbaz and baz\n");
  });

  test("a self-overlapping literal matches left-to-right, not at every offset", async () => {
    const file = join(tmpProj, "overlap.txt");
    const original = "aaaaa\n";
    await writeFile(file, original);

    // `aa` can only match at offsets 0 and 2 — the global walk resumes
    // after each match, so the trailing `a` survives and no third match
    // is straddled out of the overlap.
    const args = { pattern: "aa", replacement: "BB" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("BBBBa\n");
  });
});

describe("literal backslash in replacement", () => {
  test("a backslash in the replacement is kept exactly (Windows path, `\\n`, `\\\\`)", async () => {
    const file = join(tmpProj, "path.txt");
    const original = "dir=ROOT\n";
    await writeFile(file, original);

    // Replacement is `C:\temp\new\\x` — JS String.replace gives backslashes
    // no special meaning, so `\t`, `\n` and `\\` must not be unescaped.
    const replacement = "C:\\temp\\new\\\\x";
    const args = { pattern: "ROOT", replacement };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe(`dir=${replacement}\n`);
    expect(replacement).toHaveLength(14);
  });

  test("a backslash next to a capture reference stays literal", async () => {
    const file = join(tmpProj, "cap.txt");
    await writeFile(file, "name=foo\n");

    await ashlrSearchReplaceRegex({ pattern: "name=(\\w+)", replacement: "C:\\$1\\bin" });
    expect(await readFile(file, "utf-8")).toBe("C:\\foo\\bin\n");
  });
});

describe("literal replacement with leading and trailing spaces", () => {
  test("a ` padded ` replacement keeps both edge spaces, even at line boundaries", async () => {
    const file = join(tmpProj, "spaced.txt");
    const original = "TOKEN\nxTOKENx\n";
    await writeFile(file, original);

    const args = { pattern: "TOKEN", replacement: " padded " };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    // The first match is a whole line, so the leading space lands at
    // column 0 and the trailing space abuts the newline — a trim at
    // either edge would change these exact bytes.
    expect(await readFile(file, "utf-8")).toBe(" padded \nx padded x\n");
  });
});

describe("literal replacement containing a tab", () => {
  test("a real tab character in the replacement is preserved byte for byte", async () => {
    const file = join(tmpProj, "tabbed.txt");
    const original = "key=VALUE\nother=VALUE\n";
    await writeFile(file, original);

    const replacement = "a\tb";
    const args = { pattern: "VALUE", replacement };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    const result = await readFile(file, "utf-8");
    expect(result).toBe("key=a\tb\nother=a\tb\n");
    // One real tab per replacement, never expanded to spaces or `\t` text.
    expect(result.split("\t")).toHaveLength(3);
    expect(result).not.toContain("\\t");
  });
});

describe("literal replacement containing Unicode text", () => {
  test("preserves Unicode exactly in every replacement", async () => {
    const file = join(tmpProj, "unicode.txt");
    const original = "first=VALUE\nsecond=VALUE\n";
    await writeFile(file, original);

    // Include both composed and decomposed accents, plus non-BMP text.
    const replacement = "café e\u0301 日本語 🌍";
    const args = { pattern: "VALUE", replacement };
    const dry = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dry.text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(
      "first=café e\u0301 日本語 🌍\nsecond=café e\u0301 日本語 🌍\n",
      "utf-8",
    ));
  });
});

describe("literal question mark in pattern", () => {
  test("escaped `\\?` replaces only the question-mark text, not the optional-char meaning", async () => {
    const file = join(tmpProj, "q.txt");
    const original = "Why? Why\nWhy?? done\nWh\n";
    await writeFile(file, original);

    const args = { pattern: "Why\\?", replacement: "Because." };
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 2 replacements");
    expect(await readFile(file, "utf-8")).toBe("Because. Why\nBecause.? done\nWh\n");
  });
});

describe("literal parentheses in pattern", () => {
  test(`escaped parens match literal parentheses; unrelated text stays untouched`, async () => {
    const file = join(tmpProj, "code.txt");
    const original = "func(42)\nother(99)\nnoparens\n";
    await writeFile(file, original);

    // `\(` and `\)` escape regex capture groups → match literal parens.
    const args = { pattern: "func\\(42\\)", replacement: "process(42)" };

    // Dry run must not modify the file.
    await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(await readFile(file, "utf-8")).toBe(original);

    // Apply mode replaces only the target line.
    const { text } = await ashlrSearchReplaceRegex(args);
    expect(text).toContain("1 file, 1 replacement");
    expect(await readFile(file, "utf-8")).toBe("process(42)\nother(99)\nnoparens\n");
  });

  test(`escaped parens can mix with capture groups and dollar-backrefs`, async () => {
    const file = join(tmpProj, "notes.txt");
    await writeFile(file, "say(hello)\nsay(world)\n");

    // `\(` and `\)` match literal parens; unescaped `()` captures the word.
    // JS replacement uses `$1` (not `\1`) for backrefs.
    await ashlrSearchReplaceRegex({ pattern: "say\\((\\w+)\\)", replacement: "speak($1)" });
    expect(await readFile(file, "utf-8")).toBe("speak(hello)\nspeak(world)\n");
  });
});

describe("literal $` in replacement", () => {
  test("inserts a literal $` via $$` instead of expanding it to the text before the match", async () => {
    const file = join(tmpProj, "literal-dollar-backtick.txt");
    // $` is JS's "text before the match" token; $$` must yield the two
    // characters $`. The text before each marker ("say ", the CRLF line
    // start, "café\nlast ") must stay in place and must not be copied into
    // the replacement.
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    const expected = "say it's $`ok tail\r\nit's $`ok! café\nlast it's $`ok";
    await writeFile(file, original);

    const args = { pattern: "MARK", replacement: "it's $$`ok" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));
    // No temp/backup leftovers beside the rewritten file.
    expect(await readdir(tmpProj)).toEqual(["literal-dollar-backtick.txt"]);
  });

  test("literal replacement containing $` is written without copying the preceding text", async () => {
    const file = join(tmpProj, "preceding-input.txt");
    const original = "say MARK tail\r\nMARK! café\nlast MARK";
    await writeFile(file, original);

    // A bare $` is JS's "text before the match" token. applyRegex evaluates
    // the replacement against the match substring alone — the match spans
    // that whole substring — so the token resolves to the empty string. A
    // naive `source.replace(re, replacement)` would copy the file prefix
    // before each match into the output; the per-match walk never sees it,
    // and each prefix ("say ", "tail\r\n", "café\nlast ") stays exactly in
    // place.
    const args = { pattern: "MARK", replacement: "it's $`ok" };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 3 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 3 replacements");
    const expected = "say it's ok tail\r\nit's ok! café\nlast it's ok";
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));
    expect(await readFile(file)).toEqual(Buffer.from(expected, "utf-8"));

    // Written literally via $$`, the two characters $` land verbatim —
    // still with no preceding text copied in.
    await writeFile(file, original);
    const literal = await ashlrSearchReplaceRegex({ ...args, replacement: "it's $$`ok" });
    expect(literal.text).toContain("1 file, 3 replacements");
    expect(await readFile(file, "utf-8")).toBe(
      "say it's $`ok tail\r\nit's $`ok! café\nlast it's $`ok",
    );
    expect(await readdir(tmpProj)).toEqual(["preceding-input.txt"]);
  });

  test("negative: a pattern that matches nothing leaves the bytes untouched and reports no write", async () => {
    const file = join(tmpProj, "no-match.txt");
    const original = "say MARK tail\r\n";
    await writeFile(file, original);

    const result = await ashlrSearchReplaceRegex({ pattern: "ABSENT", replacement: "it's $`ok" });
    expect(result.text).toContain("0 files, 0 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));
    expect(await readdir(tmpProj)).toEqual(["no-match.txt"]);
  });
});
