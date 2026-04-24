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
import { join, parse as parsePath } from "path";
import { tmpdir } from "os";
import { clampToCwd } from "../servers/_cwd-clamp";
import { ashlrGlob } from "../servers/glob-server";
import { ashlrTree } from "../servers/tree-server";
import { ashlrGrep, ashlrRead } from "../servers/efficiency-server";

// Path matcher for "etc" directory refusal, accepting both POSIX forms (/etc,
// /private/etc on macOS) and Windows forms (C:\etc, D:/etc, etc.). `resolve("/etc")`
// on Windows produces a drive-prefixed path that was previously silently unmatched
// by hardcoded POSIX-only regexes.
const ETC_PATH_RE = /(?:\/(?:private\/)?etc|[A-Za-z]:[\\/]etc)/;
const ETC_HOSTS_PATH_RE = /(?:\/(?:private\/)?etc\/hosts|[A-Za-z]:[\\/]etc[\\/]hosts)/;

// A path that is definitely outside cwd on every platform. On POSIX this is
// `/etc`; on Windows it's `<drive>:\etc` which is also outside any sensible cwd.
const OUTSIDE_CWD = "/etc";
const OUTSIDE_CWD_FILE = "/etc/hosts";

// Platform-appropriate writable tmp dir for CLAUDE_PROJECT_DIR tests. Windows
// has no `/tmp`; use `os.tmpdir()` which resolves to `%TEMP%`.
const TMP_DIR = tmpdir();

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
    const r = clampToCwd(OUTSIDE_CWD, "test");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Helper canonicalizes symlinks — on macOS "/etc" becomes "/private/etc";
      // on Windows `/etc` resolves to `<drive>:\etc` which is also outside cwd.
      expect(r.message).toMatch(new RegExp("^test: refused path outside working directory: " + ETC_PATH_RE.source));
      expect(r.message).toContain(`(cwd is`);
    }
  });

  test("parent-escape via '..' is refused", () => {
    const r = clampToCwd("../..", "test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("refused path outside working directory");
  });

  test("refusal message embeds the provided tool name", () => {
    const r = clampToCwd(OUTSIDE_CWD, "ashlr__example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^ashlr__example: refused/);
  });
});

describe("ashlr__glob — cwd clamp", () => {
  test("refuses cwd outside working directory", async () => {
    const out = await ashlrGlob({ pattern: "**", cwd: OUTSIDE_CWD });
    expect(out).toMatch(new RegExp("ashlr__glob: refused path outside working directory: " + ETC_PATH_RE.source));
  });

  test("accepts cwd inside working directory", async () => {
    const out = await ashlrGlob({ pattern: "package.json", cwd: process.cwd() });
    expect(out).not.toContain("refused path outside working directory");
  });
});

describe("ashlr__tree — cwd clamp", () => {
  test("refuses path outside working directory", async () => {
    const out = await ashlrTree({ path: OUTSIDE_CWD });
    expect(out).toMatch(new RegExp("ashlr__tree: refused path outside working directory: " + ETC_PATH_RE.source));
  });

  test("accepts path inside working directory", async () => {
    const out = await ashlrTree({ path: "./scripts", depth: 1, maxEntries: 5 });
    expect(out).not.toContain("refused path outside working directory");
  });
});

describe("ashlr__grep — cwd clamp", () => {
  test("refuses cwd outside working directory", async () => {
    const out = await ashlrGrep({ pattern: "anything", cwd: OUTSIDE_CWD });
    expect(out).toMatch(new RegExp("ashlr__grep: refused path outside working directory: " + ETC_PATH_RE.source));
  });

  test("accepts cwd inside working directory", async () => {
    const out = await ashlrGrep({ pattern: "ashlr", cwd: process.cwd() });
    expect(out).not.toContain("refused path outside working directory");
  });
});

describe("ashlr__read — path clamp", () => {
  test("refuses path outside working directory", async () => {
    const out = await ashlrRead({ path: OUTSIDE_CWD_FILE });
    expect(out).toMatch(new RegExp("ashlr__read: refused path outside working directory: " + ETC_HOSTS_PATH_RE.source));
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

describe("CLAUDE_PROJECT_DIR env extends allow-list", () => {
  test("path inside CLAUDE_PROJECT_DIR is accepted even when outside cwd", () => {
    const original = process.env["CLAUDE_PROJECT_DIR"];
    // Use os.tmpdir() so the test works on Windows (%TEMP%) as well as macOS
    // (/private/tmp via realpath) and Linux (/tmp).
    process.env["CLAUDE_PROJECT_DIR"] = TMP_DIR;
    try {
      const r = clampToCwd(TMP_DIR, "test");
      expect(r.ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
      else process.env["CLAUDE_PROJECT_DIR"] = original;
    }
  });

  test("unrelated outside path is still refused when CLAUDE_PROJECT_DIR is set", () => {
    const original = process.env["CLAUDE_PROJECT_DIR"];
    process.env["CLAUDE_PROJECT_DIR"] = TMP_DIR;
    try {
      const r = clampToCwd(OUTSIDE_CWD, "test");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("refused path outside working directory");
    } finally {
      if (original === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
      else process.env["CLAUDE_PROJECT_DIR"] = original;
    }
  });

  test("refusal message lists the extra allowed roots", () => {
    const original = process.env["CLAUDE_PROJECT_DIR"];
    process.env["CLAUDE_PROJECT_DIR"] = TMP_DIR;
    try {
      const r = clampToCwd(OUTSIDE_CWD, "test");
      expect(r.ok).toBe(false);
      // Match the tail of the tmpdir basename (e.g. "tmp", "Temp") so the
      // assertion works on all three platforms.
      if (!r.ok) {
        const tailBasename = parsePath(TMP_DIR).base;
        expect(r.message).toContain(`also allowed`);
        expect(r.message.toLowerCase()).toContain(tailBasename.toLowerCase());
      }
    } finally {
      if (original === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
      else process.env["CLAUDE_PROJECT_DIR"] = original;
    }
  });

  test("empty CLAUDE_PROJECT_DIR is ignored", () => {
    const original = process.env["CLAUDE_PROJECT_DIR"];
    process.env["CLAUDE_PROJECT_DIR"] = "";
    try {
      const r = clampToCwd(OUTSIDE_CWD, "test");
      expect(r.ok).toBe(false);
    } finally {
      if (original === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
      else process.env["CLAUDE_PROJECT_DIR"] = original;
    }
  });
});

describe("ASHLR_ALLOW_PROJECT_PATHS env extends allow-list", () => {
  test("single path is accepted", () => {
    const original = process.env["ASHLR_ALLOW_PROJECT_PATHS"];
    process.env["ASHLR_ALLOW_PROJECT_PATHS"] = TMP_DIR;
    try {
      const r = clampToCwd(TMP_DIR, "test");
      expect(r.ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env["ASHLR_ALLOW_PROJECT_PATHS"];
      else process.env["ASHLR_ALLOW_PROJECT_PATHS"] = original;
    }
  });

  test("colon-separated paths on Unix are all accepted", () => {
    if (process.platform === "win32") return; // skip on Windows
    const original = process.env["ASHLR_ALLOW_PROJECT_PATHS"];
    process.env["ASHLR_ALLOW_PROJECT_PATHS"] = `/tmp:${process.cwd()}`;
    try {
      const r1 = clampToCwd("/tmp", "test");
      const r2 = clampToCwd(process.cwd(), "test");
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env["ASHLR_ALLOW_PROJECT_PATHS"];
      else process.env["ASHLR_ALLOW_PROJECT_PATHS"] = original;
    }
  });

  test("invalid path entry is skipped silently", () => {
    if (process.platform === "win32") return; // `:` separator is Unix-specific
    const original = process.env["ASHLR_ALLOW_PROJECT_PATHS"];
    process.env["ASHLR_ALLOW_PROJECT_PATHS"] = `:${TMP_DIR}: :`;
    try {
      const r1 = clampToCwd(TMP_DIR, "test");
      expect(r1.ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env["ASHLR_ALLOW_PROJECT_PATHS"];
      else process.env["ASHLR_ALLOW_PROJECT_PATHS"] = original;
    }
  });

  test("path outside all allow-listed roots is refused", () => {
    const original = process.env["ASHLR_ALLOW_PROJECT_PATHS"];
    process.env["ASHLR_ALLOW_PROJECT_PATHS"] = TMP_DIR;
    try {
      const r = clampToCwd(OUTSIDE_CWD, "test");
      expect(r.ok).toBe(false);
    } finally {
      if (original === undefined) delete process.env["ASHLR_ALLOW_PROJECT_PATHS"];
      else process.env["ASHLR_ALLOW_PROJECT_PATHS"] = original;
    }
  });
});
