import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const layout = join(import.meta.dir, "..", "site", "app", "layout.tsx");
const src = readFileSync(layout, "utf8");

describe("site fonts are self-hosted", () => {
  test("layout does not use next/font/google (build-time network fetch flaked the deploy)", () => {
    expect(src).not.toContain("next/font/google");
  });

  test("every localFont src exists on disk", () => {
    const files = [...src.matchAll(/src:\s*"\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(files.length).toBe(3);
    for (const f of files) expect(existsSync(join(layout, "..", f))).toBe(true);
  });
});
