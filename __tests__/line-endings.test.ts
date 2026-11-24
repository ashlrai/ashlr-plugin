import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("checkout line endings", () => {
  test("attributes force LF so Windows does not depend on core.autocrlf", () => {
    const attrs = readFileSync(join(import.meta.dir, "..", ".gitattributes"), "utf8");
    expect(attrs).toContain("* text=auto eol=lf");
    expect(readFileSync(join(import.meta.dir, "..", "docs/platform-support.md"), "utf8")).toContain("* text=auto eol=lf");
  });
});
