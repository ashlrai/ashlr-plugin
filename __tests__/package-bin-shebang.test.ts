import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
};

describe("package.json bin entries", () => {
  test("every bin target exists and starts with the node shebang", () => {
    const bins = pkg.bin ?? {};
    expect(Object.keys(bins).length).toBeGreaterThan(0);
    for (const [name, rel] of Object.entries(bins)) {
      const path = join(root, rel);
      expect(existsSync(path), `${name} -> ${rel} must exist`).toBe(true);
      const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
      expect(firstLine, `${name} (${rel}) first line`).toBe("#!/usr/bin/env node");
    }
  });
});
