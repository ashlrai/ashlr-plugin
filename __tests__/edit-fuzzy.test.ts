/**
 * Tests for Feature 2: Fuzzy edit matching fallback.
 *
 * Env-var isolation: ASHLR_EDIT_FUZZY is set/restored within try/finally
 * inside each test that needs it. Never set at module scope to avoid
 * polluting concurrent test files.
 *
 * Uses ashlrEdit() directly (unit-level) rather than spawning the MCP server,
 * so tests are fast and deterministic.
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
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-fuzzy-test-"));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("fuzzy edit matching", () => {
  test("exact match still wins — no fuzzy note when text matches literally", async () => {
    const file = join(tmpDir, "exact.ts");
    await writeFile(file, "const foo = 1;\n");

    const result = await ashlrEdit({
      path: file,
      search: "const foo = 1;",
      replace: "const bar = 1;",
    });

    expect(result.text).toContain("hunks applied");
    expect(result.text).not.toContain("fuzzy match");
    const content = await readFile(file, "utf-8");
    expect(content).toBe("const bar = 1;\n");
  });

  test("whitespace-only difference applies via fuzzy with note", async () => {
    // File has extra spaces; search string has single spaces — Tier 1 ws-norm match.
    const file = join(tmpDir, "ws.ts");
    await writeFile(file, "function   hello(  a,   b  ) {\n  return a + b;\n}\n");

    const result = await ashlrEdit({
      path: file,
      search: "function hello( a, b ) {\n  return a + b;\n}",
      replace: "function hello(a, b) {\n  return a + b;\n}",
    });

    expect(result.text).toContain("fuzzy match");
    expect(result.text).toContain("verify the diff");
    const content = await readFile(file, "utf-8");
    expect(content).toContain("function hello(a, b)");
  });

  test("ambiguous / low-similarity search throws unchanged 'no match' error", async () => {
    const file = join(tmpDir, "ambig.ts");
    // Two lines that look similar — should not fuzzy-match either uniquely
    await writeFile(file, "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n");

    await expect(
      ashlrEdit({
        path: file,
        search: "COMPLETELY_NONEXISTENT_TOKEN_XYZ_123",
        replace: "something",
      }),
    ).rejects.toThrow(/no match|not found/);
  });

  test("ASHLR_EDIT_FUZZY=off disables fuzzy and throws the normal error", async () => {
    const file = join(tmpDir, "fuzzy-off.ts");
    // Content has whitespace variation — would normally fuzzy-match
    await writeFile(file, "function  greet(  name  ) {\n  return name;\n}\n");

    const prev = process.env.ASHLR_EDIT_FUZZY;
    try {
      process.env.ASHLR_EDIT_FUZZY = "off";
      await expect(
        ashlrEdit({
          path: file,
          search: "function greet( name ) {\n  return name;\n}",
          replace: "function greet(name) {\n  return name;\n}",
        }),
      ).rejects.toThrow(/no match|not found/);
    } finally {
      if (prev === undefined) {
        delete process.env.ASHLR_EDIT_FUZZY;
      } else {
        process.env.ASHLR_EDIT_FUZZY = prev;
      }
    }
  });

  test("fuzzy does not trigger for strict=false (non-strict path is unchanged)", async () => {
    const file = join(tmpDir, "non-strict.ts");
    await writeFile(file, "foo foo foo\n");

    // strict=false with 3 matches — should replace all, no fuzzy
    const result = await ashlrEdit({
      path: file,
      search: "foo",
      replace: "bar",
      strict: false,
    });

    expect(result.hunksApplied).toBe(3);
    expect(result.text).not.toContain("fuzzy match");
    const content = await readFile(file, "utf-8");
    expect(content).toBe("bar bar bar\n");
  });
});
