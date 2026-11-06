import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agents = readFileSync(join(import.meta.dir, "..", "AGENTS.md"), "utf8");
const section = agents.split(/^## /m).find((s) => s.startsWith("Hot files")) ?? "";

describe("hot file rule", () => {
  test("AGENTS.md has a Hot files section", () => {
    expect(section).not.toBe("");
  });

  test("new pipe server cases go in a new test file", () => {
    expect(section).toContain("New pipe server cases go in a new test file");
    expect(section).toContain("__tests__/pipe-server.test.ts");
  });

  test("PRs do not commit regenerated docs.generated.json", () => {
    expect(section).toContain("A PR does not commit regenerated `site/lib/docs.generated.json`");
  });
});
