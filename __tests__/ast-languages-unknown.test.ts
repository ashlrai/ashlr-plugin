/**
 * ast-languages-unknown.test.ts — pins the documented unknown-language contract.
 *
 * Documented behaviour (servers/_ast-languages.ts):
 *   - resolveLanguage() returns null for unrecognised extensions.
 *   - .py/.go/.rs resolve to their Language keys (stubs, so callers can check)
 *     but getParser() throws "not wired yet" until sprint-2.
 *   - parseFile() returns null for unrecognised extensions and for unwired
 *     languages (servers/_ast-helpers.ts).
 *   - splitFileIntoChunks() mirrors parseFile: null for unsupported languages
 *     (servers/_ast-chunker.ts).
 */

import { describe, test, expect } from "bun:test";
import { resolveLanguage, getParser, type Language } from "../servers/_ast-languages";
import { parseFile } from "../servers/_ast-helpers";
import { splitFileIntoChunks } from "../servers/_ast-chunker";

// ---------------------------------------------------------------------------
// resolveLanguage — unsupported extension → null (the documented result)
// ---------------------------------------------------------------------------

describe("resolveLanguage: unknown languages", () => {
  const unsupported = [
    "style.css",
    "page.html",
    "data.json",
    "config.yaml",
    "config.yml",
    "Cargo.toml",
    "doc.md",
    "image.svg",
    "app.rb",
    "Main.java",
    "main.c",
    "vector.cpp",
    "Program.cs",
    "index.php",
    "query.sql",
    "notes.txt",
    "script.sh",
    "archive.tar.gz",
  ];

  for (const name of unsupported) {
    test(`returns null for ${name}`, () => {
      expect(resolveLanguage(name)).toBeNull();
    });
  }

  test("returns null for a bare unsupported extension", () => {
    expect(resolveLanguage(".css")).toBeNull();
  });

  test("case-insensitivity does not rescue an unknown extension", () => {
    expect(resolveLanguage("STYLE.CSS")).toBeNull();
    expect(resolveLanguage("README.MD")).toBeNull();
  });

  test("returns null for extensionless filenames", () => {
    expect(resolveLanguage("Makefile")).toBeNull();
    expect(resolveLanguage("Dockerfile")).toBeNull();
    expect(resolveLanguage("noext")).toBeNull();
    expect(resolveLanguage("")).toBeNull();
  });

  test("returns null for dotfiles (leading dot is not a supported extension)", () => {
    expect(resolveLanguage(".gitignore")).toBeNull();
    expect(resolveLanguage(".env")).toBeNull();
  });

  test("returns null for degenerate inputs", () => {
    expect(resolveLanguage(".")).toBeNull();
    expect(resolveLanguage("..")).toBeNull();
    expect(resolveLanguage("foo.")).toBeNull();
  });

  test("a supported extension in a directory name does not leak into the filename", () => {
    expect(resolveLanguage("my.ts/README")).toBeNull();
    expect(resolveLanguage("vendor.ts/bundle.css")).toBeNull();
  });

  test("a supported extension only counts at the end of the filename", () => {
    expect(resolveLanguage("foo.ts.bak")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stub languages — resolve to a key, but are NOT "supported"
// ---------------------------------------------------------------------------

describe("resolveLanguage: recognised-but-unwired stubs", () => {
  test(".py resolves to 'python' (not null) so callers can distinguish stubs", () => {
    expect(resolveLanguage("script.py")).toBe("python");
    expect(resolveLanguage("SCRIPT.PY")).toBe("python");
  });

  test(".go resolves to 'go'", () => {
    expect(resolveLanguage("main.go")).toBe("go");
  });

  test(".rs resolves to 'rust'", () => {
    expect(resolveLanguage("lib.rs")).toBe("rust");
  });
});

// ---------------------------------------------------------------------------
// getParser — throws the documented error before touching grammar files
// ---------------------------------------------------------------------------

describe("getParser: unwired and unknown languages", () => {
  const stubs: Language[] = ["python", "go", "rust"];

  for (const lang of stubs) {
    test(`rejects '${lang}' with the documented not-wired error`, async () => {
      await expect(getParser(lang)).rejects.toThrow(
        `[ast-languages] Grammar for '${lang}' is not wired yet`
      );
    });
  }

  test("rejection message tells callers to gate on resolveLanguage()", async () => {
    await expect(getParser("python")).rejects.toThrow(/resolveLanguage\(\)/);
  });

  test("an out-of-union key still fails the wired check before grammar lookup", async () => {
    // A Language value that bypassed resolveLanguage (e.g. cast from untrusted
    // input) must hit the WIRED_LANGUAGES guard — never Parser.Language.load
    // with an undefined grammar path.
    await expect(getParser("cobol" as Language)).rejects.toThrow(/not wired yet/);
  });
});

// ---------------------------------------------------------------------------
// Downstream consumers — parseFile / splitFileIntoChunks return null
// ---------------------------------------------------------------------------

describe("parseFile: unsupported extension", () => {
  test("returns null without touching the filesystem", async () => {
    // Path deliberately does not exist: the extension gate must run before
    // readFile, so this resolves null instead of throwing ENOENT.
    const result = await parseFile("/nonexistent/dir/style.css");
    expect(result).toBeNull();
  });

  test("returns null for an unwired stub language (.py)", async () => {
    // Documented graceful fallback: getParser throws, parseFile catches → null.
    const result = await parseFile("/nonexistent/dir/script.py");
    expect(result).toBeNull();
  });
});

describe("splitFileIntoChunks: unsupported extension", () => {
  test("returns null (mirrors parseFile behaviour)", async () => {
    const result = await splitFileIntoChunks("/nonexistent/dir/style.css");
    expect(result).toBeNull();
  });

  test("returns null for an unwired stub language (.go)", async () => {
    const result = await splitFileIntoChunks("/nonexistent/dir/main.go");
    expect(result).toBeNull();
  });
});
