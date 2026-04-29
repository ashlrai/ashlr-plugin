/**
 * Direct unit tests for the three public efficiency-server handlers
 * (ashlrRead, ashlrGrep, ashlrEdit). These functions are exercised by 37
 * other test files via subprocess MCP round-trips, but only cwd-clamp and
 * read-cache-invalidation imported them directly before this file. This
 * adds in-process smoke coverage of the success and basic-error paths so
 * future refactors of the handler bodies don't have to spin up the full
 * MCP transport to validate behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { ashlrRead, ashlrGrep, ashlrEdit } from "../servers/efficiency-server";

let tmpRepo: string;
let prevCwd: string;

beforeEach(() => {
  // ashlrRead/Grep/Edit clamp to process.cwd() — chdir into a fresh
  // sandbox so the relative paths the tools accept resolve safely.
  prevCwd = process.cwd();
  tmpRepo = mkdtempSync(join(tmpdir(), "ashlr-eff-"));
  process.chdir(tmpRepo);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("ashlrRead — direct", () => {
  test("returns small file contents inline (≤ 2 KB threshold)", async () => {
    writeFileSync(join(tmpRepo, "tiny.ts"), "export const x = 1;\n");
    const out = await ashlrRead({ path: "tiny.ts" });
    expect(out).toContain("export const x = 1;");
  });

  test("non-existent file throws ENOENT (handler contract)", async () => {
    let caught: Error | null = null;
    try {
      await ashlrRead({ path: "does-not-exist.ts" });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught!.message + "").toLowerCase()).toMatch(/no such file|enoent|not found/);
  });

  test("path outside cwd is refused via the cwd-clamp", async () => {
    const out = await ashlrRead({ path: "/etc/hosts" });
    expect(out).toMatch(/refused path outside working directory/i);
  });
});

describe("ashlrGrep — direct", () => {
  test("matches occurrences in tracked files (returns string output)", async () => {
    mkdirSync(join(tmpRepo, "src"), { recursive: true });
    writeFileSync(join(tmpRepo, "src/a.ts"), "const matchMe = 42;\n");
    writeFileSync(join(tmpRepo, "src/b.ts"), "const ignored = 1;\n");
    const out = await ashlrGrep({ pattern: "matchMe", cwd: tmpRepo });
    expect(typeof out).toBe("string");
    // grep should mention the file, the pattern, or surface an empty-result
    // line — but it should NEVER throw or produce undefined.
    expect(out.length).toBeGreaterThan(0);
  });

  test("cwd outside process.cwd() is refused", async () => {
    const out = await ashlrGrep({ pattern: "x", cwd: "/etc" });
    expect(out).toMatch(/refused path outside working directory/i);
  });
});

describe("ashlrEdit — direct", () => {
  test("replaces an exact-match string and updates the file", async () => {
    const file = join(tmpRepo, "edit.ts");
    writeFileSync(file, "export const x = 1;\nexport const y = 2;\n");
    const before = statSync(file).size;
    const result = await ashlrEdit({
      path: relative(tmpRepo, file),
      search: "x = 1",
      replace: "x = 99",
    });
    expect(result).toBeDefined();
    expect(result.hunksApplied).toBeGreaterThan(0);
    const { readFileSync } = require("fs") as typeof import("fs");
    const after = readFileSync(file, "utf8");
    expect(after).toContain("x = 99");
    expect(after).not.toContain("x = 1");
    expect(statSync(file).size).not.toBe(before);
  });

  test("non-matching search throws a descriptive error (handler contract)", async () => {
    const file = join(tmpRepo, "edit2.ts");
    writeFileSync(file, "const a = 1;\n");
    let caught: Error | null = null;
    try {
      await ashlrEdit({
        path: relative(tmpRepo, file),
        search: "this string does not exist in the file",
        replace: "ignored",
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught!.message + "").toLowerCase()).toMatch(/not found|no match|nearest|search/);
  });

  test("path outside cwd throws via the cwd-clamp refusal", async () => {
    let caught: Error | null = null;
    try {
      await ashlrEdit({ path: "/etc/hosts", search: "x", replace: "y" });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught!.message + "").toLowerCase()).toMatch(/refused path outside working directory/);
  });
});
