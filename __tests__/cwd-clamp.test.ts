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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

describe("Windows drive-letter canonicalization guard", () => {
  // On Windows, `fs.realpathSync("D:")` resolves to the *per-drive current
  // working directory*, not the drive root "D:\\". When clampToCwd()
  // canonicalises a non-existent outside path like "D:\\etc", its walk-up
  // reaches the drive-letter-only prefix "D:" and — without the guard —
  // realpaths it to cwd, then re-joins "etc" onto that, producing
  // "<cwd>\\etc" and wrongly clamping /etc *inside* cwd on Windows CI.
  //
  // The guard in canonical() normalises "D:" -> "D:\\" before the
  // realpathSync call so realpath resolves the drive root itself.
  //
  // We can't easily mutate process.platform mid-process (it's used by
  // path.resolve/sep at import time) to fake a Windows env on macOS, so
  // this test runs the actual refusal-on-Windows check only on Windows.
  // On POSIX it documents intent and inspects the source for the guard.

  test("source-level guard is present in canonical()", async () => {
    const file = Bun.file(join(import.meta.dir, "..", "servers", "_cwd-clamp.ts"));
    const src = await file.text();
    // Drive-letter-only prefix detection must be wired into the walk-up loop.
    expect(src).toMatch(/\[A-Za-z\]:\$/);
    expect(src).toContain("process.platform");
    expect(src).toContain("win32");
  });

  test("on Windows, /etc-style outside path is refused (not smuggled inside cwd)", () => {
    if (process.platform !== "win32") {
      // Document-only on POSIX: the bug is Windows-specific because POSIX
      // has no "drive-relative" path semantics.
      expect(true).toBe(true);
      return;
    }
    const r = clampToCwd("/etc", "test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("refused path outside working directory");
  });

  test("on Windows, C:\\nonexistent is refused (not smuggled inside cwd)", () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }
    // Pick a drive-absolute outside path that almost certainly doesn't exist
    // to exercise the walk-up code path specifically.
    const r = clampToCwd("C:\\ashlr-clamp-nonexistent-xyz", "test");
    expect(r.ok).toBe(false);
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


describe("last-project.json file-based fallback (v1.19.1 hotfix)", () => {
  /**
   * Hardest-to-hit behavior: Claude Code does NOT forward CLAUDE_PROJECT_DIR
   * to MCP subprocesses, so the clamp's env-var path can't see the user's
   * real project dir. The session-start hook writes `~/.ashlr/last-project.json`
   * which the clamp reads as a last-resort hint — BUT only when:
   *   (a) Neither CLAUDE_PROJECT_DIR nor ASHLR_ALLOW_PROJECT_PATHS is set, AND
   *   (b) process.cwd() looks like a plugin install dir (contains
   *       `.claude/plugins/cache/` OR equals $CLAUDE_PLUGIN_ROOT).
   *
   * Tests below control both axes: HOME (via env) to point homedir() at a
   * tmp dir, and CLAUDE_PLUGIN_ROOT (via env) to make process.cwd() look
   * like a plugin install (since our test cwd is the project repo).
   */

  // Test env uses ASHLR_HOME_OVERRIDE because Bun caches homedir() at startup
  // and doesn't re-read HOME on mutation. The clamp respects this override
  // as a test-only escape hatch.
  const originalHomeOverride = process.env.ASHLR_HOME_OVERRIDE;
  const originalCPD = process.env.CLAUDE_PROJECT_DIR;
  const originalAPP = process.env.ASHLR_ALLOW_PROJECT_PATHS;
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  let fakeHome: string;
  let fakeProject: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("fs/promises");
    fakeHome = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    fakeProject = await mkdtemp(join(tmpdir(), "ashlr-proj-"));
    process.env.ASHLR_HOME_OVERRIDE = fakeHome;
    // Trigger the plugin-root gate so the file fallback is considered.
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.ASHLR_ALLOW_PROJECT_PATHS;
  });

  afterEach(async () => {
    const { rm } = await import("fs/promises");
    await rm(fakeHome, { recursive: true, force: true });
    await rm(fakeProject, { recursive: true, force: true });
    // Restore env
    for (const [k, v] of [
      ["ASHLR_HOME_OVERRIDE", originalHomeOverride],
      ["CLAUDE_PROJECT_DIR", originalCPD],
      ["ASHLR_ALLOW_PROJECT_PATHS", originalAPP],
      ["CLAUDE_PLUGIN_ROOT", originalPluginRoot],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function writeHint(payload: object): void {
    const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
    mkdirSync(join(fakeHome, ".ashlr"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".ashlr", "last-project.json"),
      JSON.stringify(payload),
    );
  }

  test("fresh hint + MCP-like cwd + no env → project dir is added to allow-list", () => {
    writeHint({
      projectDir: fakeProject,
      updatedAt: new Date().toISOString(),
      sessionId: "test-session",
    });
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(true);
  });

  test("CLAUDE_PROJECT_DIR set → env wins, file is ignored (even if file points elsewhere)", async () => {
    // Point the file at tmpdir but env at a different dir.
    const { mkdtemp } = await import("fs/promises");
    const otherDir = await mkdtemp(join(tmpdir(), "ashlr-other-"));
    try {
      writeHint({ projectDir: otherDir, updatedAt: new Date().toISOString() });
      process.env.CLAUDE_PROJECT_DIR = fakeProject;
      // fakeProject is accepted via env:
      const r1 = clampToCwd(fakeProject, "ashlr__read");
      expect(r1.ok).toBe(true);
      // otherDir is NOT accepted (file was ignored because env was set):
      const r2 = clampToCwd(otherDir, "ashlr__read");
      expect(r2.ok).toBe(false);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("ASHLR_ALLOW_PROJECT_PATHS set → env wins, file is ignored", async () => {
    const { mkdtemp } = await import("fs/promises");
    const otherDir = await mkdtemp(join(tmpdir(), "ashlr-other-"));
    try {
      writeHint({ projectDir: otherDir, updatedAt: new Date().toISOString() });
      process.env.ASHLR_ALLOW_PROJECT_PATHS = fakeProject;
      const r = clampToCwd(otherDir, "ashlr__read");
      expect(r.ok).toBe(false);
    } finally {
      const { rm } = await import("fs/promises");
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("stale hint (>24h old) is ignored", () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeHint({ projectDir: fakeProject, updatedAt: stale });
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(false);
  });

  test("hint with nonexistent projectDir is ignored", () => {
    writeHint({
      projectDir: join(tmpdir(), "definitely-does-not-exist-abc-xyz-12345"),
      updatedAt: new Date().toISOString(),
    });
    const r = clampToCwd(join(tmpdir(), "definitely-does-not-exist-abc-xyz-12345"), "ashlr__read");
    expect(r.ok).toBe(false);
  });

  test("hint with missing updatedAt is ignored", () => {
    writeHint({ projectDir: fakeProject });
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(false);
  });

  test("hint with malformed JSON is ignored (no crash)", () => {
    const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
    mkdirSync(join(fakeHome, ".ashlr"), { recursive: true });
    writeFileSync(join(fakeHome, ".ashlr", "last-project.json"), "{not-json");
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(false);
  });

  test("hint with non-string projectDir is ignored", () => {
    writeHint({ projectDir: 12345, updatedAt: new Date().toISOString() });
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(false);
  });

  test("cwd NOT a plugin install dir → file fallback is NOT read (privacy)", () => {
    // Un-set the plugin-root gate so cwd stops looking like a plugin install.
    delete process.env.CLAUDE_PLUGIN_ROOT;
    writeHint({ projectDir: fakeProject, updatedAt: new Date().toISOString() });
    // fakeProject is outside process.cwd() (it's in tmpdir), so without the
    // file fallback being activated it must be refused.
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(false);
  });

  test("missing file silently falls through (no crash, no behavior change)", () => {
    // No hint file written. Plugin-root gate is on. Outside path must still refuse.
    const r = clampToCwd(fakeProject, "ashlr__read");
    expect(r.ok).toBe(false);
    // And a path inside the plugin-root cwd is still accepted.
    const r2 = clampToCwd(process.cwd(), "ashlr__read");
    expect(r2.ok).toBe(true);
  });

  test("hint pointing at a file (not directory) is ignored", async () => {
    const { writeFileSync, mkdirSync } = require("fs") as typeof import("fs");
    mkdirSync(fakeProject, { recursive: true });
    const filePath = join(fakeProject, "regular-file.txt");
    writeFileSync(filePath, "hi");
    writeHint({ projectDir: filePath, updatedAt: new Date().toISOString() });
    const r = clampToCwd(filePath, "ashlr__read");
    expect(r.ok).toBe(false);
  });
});
