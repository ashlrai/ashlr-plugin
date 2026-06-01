/**
 * Tests for Feature 3: Post-edit syntax validation loop.
 *
 * Env-var isolation: ASHLR_EDIT_VALIDATE is set/restored within try/finally
 * inside each test. Never set at module scope.
 *
 * Uses ashlrEdit() directly for speed; tree-sitter WASM is process-cached so
 * only the first parse is slow (~200-400ms on cold start).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ashlrEdit } from "../servers/edit-server";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-validate-test-"));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
  // Restore env vars — belt-and-braces in case a test threw before its finally.
  delete process.env.ASHLR_EDIT_VALIDATE;
});

describe("post-edit syntax validation", () => {
  test("TS edit that breaks syntax warns by default and still writes", async () => {
    const file = join(tmpDir, "broken.ts");
    // Valid TS to start.
    await writeFile(file, "export const x = 1;\n");

    // Replace closing semicolon with a syntax error (unclosed expression).
    const result = await ashlrEdit({
      path: file,
      search: "export const x = 1;",
      replace: "export const x = {{{",
    });

    // File IS written (warn mode = default).
    const content = await readFile(file, "utf-8");
    expect(content).toContain("{{{");

    // Result text contains the syntax warning.
    expect(result.text).toContain("⚠ syntax");
    expect(result.text).toContain("introduces a parse error");
  }, 10000); // generous timeout for WASM cold start

  test("ASHLR_EDIT_VALIDATE=block throws and does NOT write", async () => {
    const file = join(tmpDir, "block-test.ts");
    await writeFile(file, "export const y = 42;\n");

    const prev = process.env.ASHLR_EDIT_VALIDATE;
    try {
      process.env.ASHLR_EDIT_VALIDATE = "block";
      await expect(
        ashlrEdit({
          path: file,
          search: "export const y = 42;",
          replace: "export const y = {{{",
        }),
      ).rejects.toThrow(/refused.*syntax error|introduces a syntax error/);

      // File must NOT be written.
      const content = await readFile(file, "utf-8");
      expect(content).toBe("export const y = 42;\n");
    } finally {
      if (prev === undefined) {
        delete process.env.ASHLR_EDIT_VALIDATE;
      } else {
        process.env.ASHLR_EDIT_VALIDATE = prev;
      }
    }
  }, 10000);

  test("edit on already-broken TS does not warn (don't blame the edit)", async () => {
    const file = join(tmpDir, "already-broken.ts");
    // File already has a syntax error.
    await writeFile(file, "export const z = {{{;\n");

    // Make a benign replacement elsewhere in the broken file.
    const result = await ashlrEdit({
      path: file,
      search: "export const z",
      replace: "export const zz",
    });

    expect(result.text).not.toContain("⚠ syntax");
    const content = await readFile(file, "utf-8");
    expect(content).toContain("zz");
  }, 10000);

  test("JSON edit producing invalid JSON warns", async () => {
    const file = join(tmpDir, "data.json");
    await writeFile(file, '{"key": "value"}\n');

    const result = await ashlrEdit({
      path: file,
      search: '"value"',
      replace: '"value",,,,',
    });

    expect(result.text).toContain("⚠ syntax");
    // File is still written in warn mode.
    const content = await readFile(file, "utf-8");
    expect(content).toContain(",,,");
  });

  test("plain .txt edit never warns regardless of content", async () => {
    const file = join(tmpDir, "notes.txt");
    await writeFile(file, "hello world\n");

    const result = await ashlrEdit({
      path: file,
      search: "hello world",
      replace: "{{{{ broken syntax !@#$",
    });

    expect(result.text).not.toContain("⚠ syntax");
    const content = await readFile(file, "utf-8");
    expect(content).toContain("broken syntax");
  });

  test("ASHLR_EDIT_VALIDATE=block allows a syntactically valid TS edit", async () => {
    const file = join(tmpDir, "valid.ts");
    await writeFile(file, "export const a = 1;\n");

    const prev = process.env.ASHLR_EDIT_VALIDATE;
    try {
      process.env.ASHLR_EDIT_VALIDATE = "block";
      const result = await ashlrEdit({
        path: file,
        search: "const a = 1",
        replace: "const a = 2",
      });
      expect(result.text).toContain("hunks applied");
      expect(result.text).not.toContain("⚠ syntax");
      const content = await readFile(file, "utf-8");
      expect(content).toContain("const a = 2");
    } finally {
      if (prev === undefined) {
        delete process.env.ASHLR_EDIT_VALIDATE;
      } else {
        process.env.ASHLR_EDIT_VALIDATE = prev;
      }
    }
  }, 10000);
});
