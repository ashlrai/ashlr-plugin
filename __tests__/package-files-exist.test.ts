import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

describe("package.json files array", () => {
  const files = readJson<string[]>("package.json").files;

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
});
