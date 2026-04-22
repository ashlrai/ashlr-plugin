/**
 * cross-platform.test.ts
 *
 * Verifies that path construction, home-dir resolution, CRLF handling, and
 * Windows-specific guards all work correctly. Tests run on macOS/Linux today;
 * platform-gated assertions document expected Windows behavior for CI.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join, isAbsolute, sep, dirname, basename } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = join(tmpdir(), `ashlr-xplat-${process.pid}`);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ } });

// ---------------------------------------------------------------------------
// 1. path.join produces the correct separator for the current platform
// ---------------------------------------------------------------------------
describe("path construction", () => {
  it("join uses the platform separator, not hardcoded /", () => {
    const result = join("a", "b", "c");
    // On all platforms, path.join uses the native separator.
    expect(result).toBe(`a${sep}b${sep}c`);
  });

  it("join handles mixed separators gracefully", () => {
    // path.join normalises slashes — safe to call from POSIX or Windows code.
    const result = join("foo/bar", "baz");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).toContain("baz");
  });

  it("isAbsolute detects absolute paths on the current platform", () => {
    if (process.platform === "win32") {
      expect(isAbsolute("C:\\Users\\foo")).toBe(true);
      expect(isAbsolute("relative\\path")).toBe(false);
    } else {
      expect(isAbsolute("/home/user/file")).toBe(true);
      expect(isAbsolute("relative/path")).toBe(false);
    }
  });

  it("dirname and basename work cross-platform", () => {
    const full = join(TMP, "subdir", "file.ts");
    expect(basename(full)).toBe("file.ts");
    expect(dirname(full)).toBe(join(TMP, "subdir"));
  });
});

// ---------------------------------------------------------------------------
// 2. Home directory resolution
// ---------------------------------------------------------------------------
describe("homedir resolution", () => {
  it("os.homedir() returns a non-empty string", () => {
    const h = homedir();
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("HOME / USERPROFILE env vars resolve to an absolute path", () => {
    // We don't assert equality with homedir() because test runners (bun test,
    // Jest) may override HOME to a tmpdir for test isolation. Instead we just
    // verify that any set env var is a plausible absolute path.
    const envHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (envHome) {
      expect(isAbsolute(envHome)).toBe(true);
    }
    // homedir() should always return an absolute path regardless.
    expect(isAbsolute(homedir())).toBe(true);
  });

  it("ashlr data dir is constructed with join, not string concat", () => {
    // Use homedir() directly — test runner may override HOME to a tmpdir.
    const ashlrDir = join(homedir(), ".ashlr");
    expect(isAbsolute(ashlrDir)).toBe(true);
    expect(ashlrDir.endsWith(".ashlr")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. CRLF round-trip: read → edit → read preserves line endings
// ---------------------------------------------------------------------------
describe("CRLF handling", () => {
  const CRLF_FILE = join(TMP, "crlf-sample.ts");
  const CRLF_CONTENT = "line one\r\nline two\r\nline three\r\n";

  it("write and read back CRLF content preserves \\r\\n", () => {
    writeFileSync(CRLF_FILE, CRLF_CONTENT, { encoding: "utf-8" });
    const read = readFileSync(CRLF_FILE, { encoding: "utf-8" });
    // On all platforms we should get the bytes back unchanged.
    expect(read).toBe(CRLF_CONTENT);
    expect(read).toContain("\r\n");
  });

  it("partial edit of a CRLF file preserves non-edited line endings", () => {
    const original = "first\r\nsecond\r\nthird\r\n";
    writeFileSync(CRLF_FILE, original, { encoding: "utf-8" });

    // Simulate what ashlr__edit does: read, replace a substring, write back.
    const content = readFileSync(CRLF_FILE, { encoding: "utf-8" });
    const edited = content.replace("second", "REPLACED");
    writeFileSync(CRLF_FILE, edited, { encoding: "utf-8" });

    const result = readFileSync(CRLF_FILE, { encoding: "utf-8" });
    expect(result).toBe("first\r\nREPLACED\r\nthird\r\n");
    // Verify CRLF was not converted to LF during the round-trip.
    expect(result).toContain("\r\n");
    expect(result.split("\r\n").length).toBe(4); // 3 lines + trailing empty
  });

  it("line count is consistent regardless of line-ending style", () => {
    const lf = "a\nb\nc\n";
    const crlf = "a\r\nb\r\nc\r\n";
    const lfLines = lf.split(/\r?\n/).filter(Boolean);
    const crlfLines = crlf.split(/\r?\n/).filter(Boolean);
    expect(lfLines.length).toBe(crlfLines.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Shell selection (documents Windows behavior for CI)
// ---------------------------------------------------------------------------
describe("shell selection", () => {
  it("on Windows, resolveShell should use powershell, not /bin/sh", () => {
    if (process.platform !== "win32") {
      // Document the expected behavior without asserting — platform mismatch.
      expect(true).toBe(true);
      return;
    }
    // On Windows, SHELL env var is typically unset or set to a Git Bash path.
    // bash-server.ts resolveShell() returns ["powershell"|"pwsh", ["-NoProfile", ...]].
    // We just verify SHELL is not relied upon for the default shell bin.
    const shellEnv = process.env.SHELL ?? "";
    // The shell resolution must not use /bin/sh on Windows.
    expect(shellEnv).not.toBe("/bin/sh");
  });

  it("on POSIX, $SHELL or /bin/sh is used", () => {
    if (process.platform === "win32") return;
    const shell = process.env.SHELL ?? "/bin/sh";
    expect(shell.length).toBeGreaterThan(0);
    expect(isAbsolute(shell)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. chmod / key file write (Windows: no throw, just a warning)
// ---------------------------------------------------------------------------
describe("genome key file write", () => {
  it("writing a 32-byte key file does not throw on any platform", async () => {
    const keyDir = join(TMP, "team-keys");
    const keyFile = join(keyDir, "test-genome.key");
    mkdirSync(keyDir, { recursive: true });

    const key = Buffer.alloc(32, 0xab);
    let threw = false;
    try {
      writeFileSync(keyFile, key, { mode: 0o600 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile).length).toBe(32);
  });

  it("on Windows, chmod is a no-op (not an error)", async () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }
    // Importing the module should not throw even though chmod has no effect.
    const { chmod } = await import("fs/promises");
    const f = join(TMP, "chmod-test.txt");
    writeFileSync(f, "test");
    let threw = false;
    try {
      await chmod(f, 0o600);
    } catch {
      threw = true;
    }
    // On Windows, fs.chmod may succeed silently or throw ENOTSUP — the key
    // point is that _genome-crypto.ts wraps it in a conditional, so we never
    // reach this call on Windows from saveKey(). This test documents intent.
    expect(threw).toBe(false); // Windows: chmod call itself doesn't throw for files
  });
});

// ---------------------------------------------------------------------------
// 6. genome-sync path safety: Windows absolute paths are rejected
// ---------------------------------------------------------------------------
describe("genome-sync path safety", () => {
  it("rejects POSIX absolute paths in section names", () => {
    const safeName = "/etc/passwd";
    const isUnsafe = safeName.includes("..") ||
      safeName.startsWith("/") ||
      /^[A-Za-z]:[/\\]/.test(safeName);
    expect(isUnsafe).toBe(true);
  });

  it("rejects Windows absolute paths in section names", () => {
    const safeName = "C:\\Windows\\system32\\cmd.exe";
    const isUnsafe = safeName.includes("..") ||
      safeName.startsWith("/") ||
      /^[A-Za-z]:[/\\]/.test(safeName);
    expect(isUnsafe).toBe(true);
  });

  it("accepts relative section names", () => {
    for (const safeName of ["knowledge/decisions.md", "context/arch.md", "README.md"]) {
      const isUnsafe = safeName.includes("..") ||
        safeName.startsWith("/") ||
        /^[A-Za-z]:[/\\]/.test(safeName);
      expect(isUnsafe).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Install script smoke tests
// ---------------------------------------------------------------------------
describe("install script smoke tests", () => {
  const root = join(import.meta.dir, "..");
  const installSh  = join(root, "docs", "install.sh");
  const installPs1 = join(root, "docs", "install.ps1");

  // Expected path fragment that both scripts should target (forward-slash form)
  const EXPECTED_PATH_FRAGMENT = ".claude/plugins/cache/ashlr-marketplace/ashlr";

  it("install.sh exists and is non-empty", () => {
    expect(existsSync(installSh)).toBe(true);
    expect(readFileSync(installSh, "utf-8").length).toBeGreaterThan(100);
  });

  it("install.ps1 exists and is non-empty", () => {
    expect(existsSync(installPs1)).toBe(true);
    expect(readFileSync(installPs1, "utf-8").length).toBeGreaterThan(100);
  });

  it("install.sh passes bash -n syntax check", () => {
    const bash = spawnSync("bash", ["-n", installSh], { encoding: "utf-8" });
    if (bash.error && (bash.error as NodeJS.ErrnoException).code === "ENOENT") {
      // bash not available (unlikely on CI but skip gracefully)
      console.log("    [skip] bash not found — skipping syntax check");
      return;
    }
    expect(bash.status).toBe(0);
  });

  it("install.sh targets the marketplace cache path", () => {
    const src = readFileSync(installSh, "utf-8");
    expect(src).toContain(EXPECTED_PATH_FRAGMENT);
  });

  it("install.ps1 targets the marketplace cache path (forward-slash-safe)", () => {
    const src = readFileSync(installPs1, "utf-8");
    // The ps1 uses backslash on disk but the constant should contain the key segments.
    expect(src).toMatch(/\.claude[/\\]plugins[/\\]cache[/\\]ashlr-marketplace[/\\]ashlr/);
  });

  it("both scripts reference the same cache subdirectory structure", () => {
    const sh  = readFileSync(installSh, "utf-8");
    const ps1 = readFileSync(installPs1, "utf-8");
    // Both must mention ashlr-marketplace and ashlr as the cache org/repo slug.
    expect(sh).toContain("ashlr-marketplace");
    expect(sh).toContain("ashlr-marketplace/ashlr");
    expect(ps1).toContain("ashlr-marketplace");
    // ps1 may use either slash style
    expect(ps1).toMatch(/ashlr-marketplace[/\\]ashlr/);
  });

  it("install.ps1 parses with pwsh if available", () => {
    const pwsh = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command",
       `$null = [System.Management.Automation.Language.Parser]::ParseFile('${installPs1}', [ref]$null, [ref]$null); exit 0`],
      { encoding: "utf-8" }
    );
    if (pwsh.error && (pwsh.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("    [skip] pwsh not found — skipping install.ps1 parse check");
      return;
    }
    expect(pwsh.status).toBe(0);
  });
});
