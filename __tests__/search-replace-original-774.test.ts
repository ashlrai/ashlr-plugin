/**
 * search-replace-original-774.test.ts — restored original test callbacks.
 *
 * Two tests excised from search-replace-regex.test.ts:
 *   - "literal search replaces every match in adjacent runs and keeps each odd-length tail"
 *     (apply path: direct call + dry run, CRLF, EOF, 9 replacements)
 *   - "tiles an adjacent literal run with no gap and leaves the odd-length tail"
 *     (applyRegex pure path: 4 replacements, capped=false, "NNN Na")
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ashlrSearchReplaceRegex,
  applyRegex,
} from "../servers/search-replace-regex-server";
import "../servers/search-replace-regex-server-handlers";

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

describe("original-774 · restored tests", () => {
  test("literal search replaces every match in adjacent runs and keeps each odd-length tail", async () => {
    const file = join(tmpProj, "adjacent-runs.txt");
    // "aa" carries no metacharacters — a pure literal search. Each run of
    // `a`s tiles into back-to-back matches: six become three replacements
    // with no gap, four become two. The odd runs ("aaa", "aaaaa") keep a
    // single trailing "a" the non-overlapping scan must not consume, and
    // the lone "a" plus "aXa" never match at all. rg reports the file
    // once for all nine replacements; the final run sits at EOF with no
    // trailing newline.
    const original = "aaaaaa a aa aaa aXa\r\nkeep aaaa mid\naaaaa";
    const expected = "NNN a N Na aXa\r\nkeep NN mid\nNNa";
    await writeFile(file, original);

    const args = { pattern: "aa", replacement: "N", roots: [file] };
    const dryRun = await ashlrSearchReplaceRegex({ ...args, dryRun: true });
    expect(dryRun.text).toContain("1 file, 9 replacements");
    expect(await readFile(file)).toEqual(Buffer.from(original, "utf-8"));

    const result = await ashlrSearchReplaceRegex(args);
    expect(result.text).toContain("1 file, 9 replacements");
    expect(result.originalBytes).toBe(Buffer.byteLength(original, "utf-8"));
    expect(result.newBytes).toBe(Buffer.byteLength(expected, "utf-8"));

    const after = await readFile(file, "utf-8");
    expect(after).toBe(expected);
    // One "N" per adjacent "aa" pair — nine matches, nine replacements —
    // and no "aa" survives anywhere, including inside the odd runs.
    expect((after.match(/N/g) ?? []).length).toBe(9);
    expect(after).not.toContain("aa");

    // Assert each line individually so a swallowed tail can't hide
    // inside a whole-file comparison.
    const lines = after.split("\n");
    expect(lines[0]).toBe("NNN a N Na aXa\r");
    expect(lines[1]).toBe("keep NN mid");
    expect(lines[2]).toBe("NNa");
  });

  test("tiles an adjacent literal run with no gap and leaves the odd-length tail", () => {
    // "aa" matches non-overlapping left to right: six `a`s are three
    // back-to-back matches, and "aaa" leaves a single trailing "a" the
    // scan must not consume.
    const { updated, count, capped } = applyRegex("aaaaaa aaa", /aa/g, "N", 100);
    expect(count).toBe(4);
    expect(capped).toBe(false);
    expect(updated).toBe("NNN Na");
  });
});
