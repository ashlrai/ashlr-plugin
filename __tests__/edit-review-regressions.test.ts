/**
 * Regressions found reviewing #169 (header-only summary for exact unique matches):
 * the summary is only trustworthy when "unique" really means unique and the
 * applied range is the one the caller described.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ashlrEdit } from "../servers/edit-server";
import { findFuzzyMatch } from "../servers/_edit-match";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-edit-review-"));
  process.chdir(tmpDir);
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("strict uniqueness counts overlapping occurrences", () => {
  test("a search that occurs twice with overlap is refused, file untouched", async () => {
    const file = join(tmpDir, "o.ts");
    const content = "  }\n}\n}\n";
    await writeFile(file, content);
    // "}\n}" starts at offset 2 and at offset 4; a non-overlapping scan sees one.
    await expect(ashlrEdit({ path: file, search: "}\n}", replace: "}\n}\n// end" })).rejects.toThrow(
      /matched 2 times/,
    );
    expect(await readFile(file, "utf-8")).toBe(content);
  });

  test("strict:false still replaces non-overlapping occurrences", async () => {
    const file = join(tmpDir, "o2.ts");
    await writeFile(file, "aaa\n");
    const r = await ashlrEdit({ path: file, search: "aa", replace: "b", strict: false });
    expect(r.hunksApplied).toBe(1);
    expect(await readFile(file, "utf-8")).toBe("ba\n");
  });
});

describe("tier-2 fuzzy match keeps the line terminator after the window", () => {
  test("findFuzzyMatch range ends at the end of the last matched line", () => {
    const content = "x\nconst value = 1;\nconst other = 2;\ny\n";
    const m = findFuzzyMatch(content, "const value = 1;\nconst othr = 2;");
    expect(m).not.toBeNull();
    expect(content.slice(m!.start, m!.end)).toBe("const value = 1;\nconst other = 2;");
  });

  test("ashlrEdit via tier-2 fuzzy does not join the next line", async () => {
    const file = join(tmpDir, "f.ts");
    await writeFile(file, "x\nconst value = 1;\nconst other = 2;\ny\n");
    const r = await ashlrEdit({
      path: file,
      search: "const value = 1;\nconst othr = 2;",
      replace: "const value = 1;\nconst other = 3;",
    });
    expect(r.text).toContain("fuzzy match");
    expect(await readFile(file, "utf-8")).toBe("x\nconst value = 1;\nconst other = 3;\ny\n");
  });

  test("CRLF file keeps its CRLF after the window", async () => {
    const file = join(tmpDir, "crlf.ts");
    await writeFile(file, "x\r\nconst value = 1;\r\nconst other = 2;\r\ny\r\n");
    await ashlrEdit({
      path: file,
      search: "const value = 1;\nconst other = 2;",
      replace: "const value = 1;\nconst other = 3;",
    });
    expect(await readFile(file, "utf-8")).toEndWith("const other = 3;\r\ny\r\n");
  });

  test("a search ending in a newline consumes that newline only", async () => {
    const file = join(tmpDir, "nl.ts");
    await writeFile(file, "x\nconst value = 1;\nconst other = 2;\ny\n");
    await ashlrEdit({
      path: file,
      search: "const value = 1;\nconst othr = 2;\n",
      replace: "const value = 1;\nconst other = 3;\n",
    });
    expect(await readFile(file, "utf-8")).toBe("x\nconst value = 1;\nconst other = 3;\ny\n");
  });
});

describe("fuzzy summary shows what was actually replaced", () => {
  test("a tiny fuzzy edit still echoes the matched file text, not the caller's search", async () => {
    const file = join(tmpDir, "t.ts");
    await writeFile(file, "a\nlet q = 1;\nb\n");
    const r = await ashlrEdit({ path: file, search: "let q = 2;", replace: "let q = 3;" });
    expect(r.text).toContain("fuzzy match");
    expect(r.text).toContain("removed (");
    expect(r.text).toContain("let q = 1;");
    expect(await readFile(file, "utf-8")).toBe("a\nlet q = 3;\nb\n");
  });
});
