import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A docs-only diff selects no tests in scripts/premerge-local.ts, and the PR
// run of CI runs no tests, so the docs-only `bun test` lines in AGENTS.md are
// the only tests a docs contributor runs before the merge queue. Keep every
// copy of those lines identical, runnable, and complete: each
// `__tests__/contributing-*.test.ts` guard belongs on the contributor line.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const COPIES = [
  "llms-full.txt",
  "site/content/docs/contributing/testing.mdx",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

function docsOnlyLines(): string[] {
  const agents = read("AGENTS.md");
  const start = agents.indexOf("## Work in this repository");
  expect(start, "AGENTS.md has no Work in this repository section").toBeGreaterThan(-1);
  const block = agents.slice(start).match(/```bash\n([\s\S]*?)```/);
  expect(block, "AGENTS.md Work in this repository has no bash block").not.toBeNull();
  return block![1].split("\n").filter((line) => line.startsWith("bun test __tests__/"));
}

describe("docs-only test set", () => {
  const lines = docsOnlyLines();

  test("AGENTS.md gives the README line and the contributor-docs line", () => {
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("__tests__/readme-links.test.ts");
    expect(lines[1]).toContain("__tests__/pr-template-commands.test.ts");
  });

  test("every listed test file exists", () => {
    for (const line of lines) {
      for (const file of line.split(" ").slice(2)) {
        expect(existsSync(join(root, file)), `${file} is missing`).toBe(true);
      }
    }
  });

  test("every contributing-*.test.ts guard is on the contributor-docs line", () => {
    const guards = readdirSync(join(root, "__tests__")).filter((name) => /^contributing-.*\.test\.ts$/.test(name));
    expect(guards.length).toBeGreaterThan(0);
    for (const name of guards) {
      expect(lines[1], `${name} is not in the AGENTS.md docs-only set`).toContain(`__tests__/${name}`);
    }
  });

  for (const path of COPIES) {
    test(`${path} repeats both lines verbatim`, () => {
      const text = read(path);
      for (const line of lines) {
        expect(text, `${path} drifted from AGENTS.md`).toContain(line);
      }
    });
  }
});
