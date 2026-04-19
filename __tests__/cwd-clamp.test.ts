/**
 * Tests for the shared cwd clamp helper (servers/_cwd-clamp.ts) and its
 * application across the filesystem-touching MCP tools.
 *
 * The helper refuses any caller-supplied path that resolves outside
 * process.cwd(). Integration tests below verify each tool returns the
 * refusal string (rather than reading arbitrary filesystem locations)
 * when called with paths like "/etc" or "..".
 *
 * ls-server's clamp path is exercised via its own v1.11.1 tests; this
 * file covers the helper itself plus the three tools the clamp was
 * propagated to in v1.11.2 (glob, tree, grep).
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import { clampToCwd } from "../servers/_cwd-clamp";
import { ashlrGlob } from "../servers/glob-server";
import { ashlrTree } from "../servers/tree-server";
import { ashlrGrep, ashlrRead } from "../servers/efficiency-server";

describe("clampToCwd helper", () => {
  test("undefined input resolves to cwd and is accepted", () => {
    const r = clampToCwd(undefined, "test");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(process.cwd());
  });

  test("empty string resolves to cwd and is accepted", () => {
    const r = clampToCwd("", "test");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(process.cwd());
  });

  test("relative path inside cwd is accepted", () => {
    const r = clampToCwd("./scripts", "test");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs.startsWith(process.cwd())).toBe(true);
  });

  test("absolute path equal to cwd is accepted", () => {
    const r = clampToCwd(process.cwd(), "test");
    expect(r.ok).toBe(true);
  });

  test("nested absolute path inside cwd is accepted", () => {
    const r = clampToCwd(join(process.cwd(), "scripts"), "test");
    expect(r.ok).toBe(true);
  });

  test("absolute path outside cwd is refused", () => {
    const r = clampToCwd("/etc", "test");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Helper canonicalizes symlinks — on macOS "/etc" becomes "/private/etc".
      expect(r.message).toMatch(/^test: refused path outside working directory: \/(private\/)?etc/);
      expect(r.message).toContain(`(cwd is`);
    }
  });

  test("parent-escape via '..' is refused", () => {
    const r = clampToCwd("../..", "test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("refused path outside working directory");
  });

  test("refusal message embeds the provided tool name", () => {
    const r = clampToCwd("/etc", "ashlr__example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^ashlr__example: refused/);
  });
});

describe("ashlr__glob — cwd clamp", () => {
  test("refuses cwd outside working directory", async () => {
    const out = await ashlrGlob({ pattern: "**", cwd: "/etc" });
    expect(out).toMatch(/ashlr__glob: refused path outside working directory: \/(private\/)?etc/);
  });

  test("accepts cwd inside working directory", async () => {
    const out = await ashlrGlob({ pattern: "package.json", cwd: process.cwd() });
    expect(out).not.toContain("refused path outside working directory");
  });
});

describe("ashlr__tree — cwd clamp", () => {
  test("refuses path outside working directory", async () => {
    const out = await ashlrTree({ path: "/etc" });
    expect(out).toMatch(/ashlr__tree: refused path outside working directory: \/(private\/)?etc/);
  });

  test("accepts path inside working directory", async () => {
    const out = await ashlrTree({ path: "./scripts", depth: 1, maxEntries: 5 });
    expect(out).not.toContain("refused path outside working directory");
  });
});

describe("ashlr__grep — cwd clamp", () => {
  test("refuses cwd outside working directory", async () => {
    const out = await ashlrGrep({ pattern: "anything", cwd: "/etc" });
    expect(out).toMatch(/ashlr__grep: refused path outside working directory: \/(private\/)?etc/);
  });

  test("accepts cwd inside working directory", async () => {
    const out = await ashlrGrep({ pattern: "ashlr", cwd: process.cwd() });
    expect(out).not.toContain("refused path outside working directory");
  });
});

describe("ashlr__read — path clamp", () => {
  test("refuses path outside working directory", async () => {
    const out = await ashlrRead({ path: "/etc/hosts" });
    expect(out).toMatch(/ashlr__read: refused path outside working directory: \/(private\/)?etc\/hosts/);
  });

  test("accepts path inside working directory", async () => {
    const out = await ashlrRead({ path: "./package.json" });
    expect(out).not.toContain("refused path outside working directory");
    // Sanity: actually returned the file content.
    expect(out).toContain("ashlr-plugin");
  });
});

describe("ashlr__edit / ashlr__multi_edit — throw on outside-cwd paths", () => {
  test("ashlr__edit imports clamp and guards its path arg", async () => {
    // ashlrEdit is not exported (intentional — it's tool-dispatched), but the
    // presence of the refusal string in the server source proves the guard is
    // wired. Combined with the MCP integration test in multi-edit-server.test.ts,
    // this is sufficient coverage to fail if the guard were removed.
    const file = Bun.file(join(import.meta.dir, "..", "servers", "efficiency-server.ts"));
    const src = await file.text();
    expect(src).toContain(`clampToCwd(relPath, "ashlr__edit")`);
    expect(src).toMatch(/if \(!clamp\.ok\) throw new Error\(clamp\.message\)/);
  });

  test("ashlr__multi_edit clamps every edit path before any FS I/O", async () => {
    const file = Bun.file(join(import.meta.dir, "..", "servers", "multi-edit-server.ts"));
    const src = await file.text();
    expect(src).toContain(`clampToCwd(e.path, "ashlr__multi_edit")`);
    expect(src).toMatch(/if \(!clamp\.ok\) throw new Error\(clamp\.message\)/);
    // The clamp must happen in the validation pass, *before* the read-files pass.
    const clampIdx = src.indexOf(`clampToCwd(e.path, "ashlr__multi_edit")`);
    const readIdx = src.indexOf(`await readFile(abs`);
    expect(clampIdx).toBeGreaterThan(0);
    expect(readIdx).toBeGreaterThan(clampIdx);
  });
});

describe("DoS cap on canonical() walk-up", () => {
  test("pathological long non-existent path does not hang", () => {
    // 200-segment non-existent path — before the cap, this caused ~200
    // synchronous realpathSync failures. With MAX_WALK_UP = 32, the loop
    // exits cleanly and the clamp refuses (path stays absolute + outside cwd).
    const longPath = "/" + Array(200).fill("doesnotexist").join("/");
    const start = Date.now();
    const r = clampToCwd(longPath, "test");
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
});
