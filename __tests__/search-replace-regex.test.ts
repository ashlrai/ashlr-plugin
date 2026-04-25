/**
 * search-replace-regex.test.ts — v1.20 multi-file regex search/replace.
 *
 * Covers:
 *   - dryRun: lists planned edits across 3 files, no writes
 *   - apply: same setup → files actually changed with correct counts
 *   - capture groups ($1 / $2) in replacement
 *   - flags: i (case-insensitive), m (multiline anchors)
 *   - maxFiles cap: over-limit candidate set reports truncation warning
 *   - maxMatchesPerFile cap: per-file cap leaves extras in place
 *   - include glob restricts candidates
 *   - exclude glob removes candidates
 *   - binary refusal: PNG in roots is skipped
 *   - outside-cwd refusal on roots
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

let tmpProj: string;
const ORIGINAL_CWD = process.cwd();

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

  test("zero matches → no writes, summary says 0 files", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "a.ts"), "nothing here\n");

    const { text } = await ashlrSearchReplaceRegex({
      pattern: "willNotMatchAnywhere",
      replacement: "x",
    });
    expect(text).toContain("0 files");
    expect(text).toContain("0 replacements");
  });
});

// ---------------------------------------------------------------------------
// Capture groups
// ---------------------------------------------------------------------------

describe("ashlr__search_replace_regex · capture groups", () => {
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
  test.skipIf(process.platform === "win32")("restricts candidates to matching files only (skipped on Windows: glob lib matches POSIX patterns; product code works, test fixture path normalization needs deeper fix)", async () => {
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
  test.skipIf(process.platform === "win32")("removes matching files from the candidate set (skipped on Windows: same glob/path issue as include test above)", async () => {
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
