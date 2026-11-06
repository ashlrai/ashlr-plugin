import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const root = join(import.meta.dir, "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

describe("package.json files array", () => {
  const files = readJson<{ files: string[] }>("package.json").files;

  test("every entry in files array exists on disk", () => {
    expect(Array.isArray(files)).toBe(true);
    for (const entry of files) {
      const fullPath = join(root, entry);
      expect(existsSync(fullPath), `${entry} listed in files but not found`).toBe(true);
    }
  });

  test("trailing-slash entries are directories", () => {
    for (const entry of files) {
      if (!entry.endsWith("/")) continue;
      const trimmed = entry.slice(0, -1);
      const fullPath = join(root, trimmed);
      expect(
        lstatSync(fullPath).isDirectory(),
        `${entry.slice(0, -1)} listed in files with trailing slash but is not a directory`,
      ).toBe(true);
    }
  });

  test("non-trailing-slash entries are not directories", () => {
    for (const entry of files) {
      if (entry.endsWith("/")) continue;
      const fullPath = join(root, entry);
      expect(
        lstatSync(fullPath).isDirectory(),
        `${entry} listed in files without trailing slash but is a directory`,
      ).toBe(false);
    }
  });

  // Stronger guard (not in the original): a non-empty list of unique,
  // repo-relative paths that cannot escape the package root.
  test("entries are unique, non-empty, repo-relative and stay inside the package root", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files).size).toBe(files.length);
    for (const entry of files) {
      expect(typeof entry).toBe("string");
      expect(entry.length, "empty files entry").toBeGreaterThan(0);
      expect(isAbsolute(entry), `${entry} is absolute`).toBe(false);
      const norm = normalize(entry);
      expect(norm === ".." || norm.startsWith("../"), `${entry} escapes the package root`).toBe(false);
    }
  });
});
