/** The edit summary echoes removed/added text only when the match was not an exact unique one. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ashlrEdit } from "../servers/edit-server";

let tmpDir: string;
let originalCwd: string;
const SEARCH = "function processItems(items: string[]): string[] {\n  return items.filter(Boolean).map(s => s.trim());\n}\n";
const REPLACE = "function processItems(items: string[]): string[] {\n  return items.filter(Boolean).map(s => s.trim()).sort();\n}\n";

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-echo-test-"));
  process.chdir(tmpDir);
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("edit summary echo", () => {
  test("exact unique match above 120 chars returns the header only", async () => {
    const file = join(tmpDir, "a.ts");
    await writeFile(file, SEARCH + "export {};\n");
    const r = await ashlrEdit({ path: file, search: SEARCH, replace: REPLACE });
    expect(r.text).toContain("1 of 1 hunks applied");
    expect(r.text).not.toContain("removed (");
    expect(r.text.split("\n").length).toBe(1);
  });

  test("replace-all (strict:false) keeps the detail lines", async () => {
    const file = join(tmpDir, "b.ts");
    await writeFile(file, SEARCH + SEARCH);
    const r = await ashlrEdit({ path: file, search: SEARCH, replace: REPLACE, strict: false });
    expect(r.text).toContain("2 of 2 hunks applied");
    expect(r.text).toContain("removed (");
    expect(r.text).toContain("added   (");
  });

  test("fuzzy match keeps the detail lines", async () => {
    const file = join(tmpDir, "c.ts");
    await writeFile(file, SEARCH.replace("items.filter", "items.filter").replace(/ {2}return/, "    return") + "export {};\n");
    const r = await ashlrEdit({ path: file, search: SEARCH, replace: REPLACE });
    expect(r.text).toContain("fuzzy match");
    expect(r.text).toContain("removed (");
  });
});
