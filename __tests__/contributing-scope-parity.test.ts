import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CONTRIBUTING.md and the website's Contributing page both carry the first-run
// dev loop and the "what belongs / what doesn't" scope lists. They drifted once
// (different clone command, missing smoke and bench steps, scope items on only
// one page), so a first-time contributor got a different answer depending on
// which page they opened. These checks keep the two pages saying the same thing.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const PAGES = ["CONTRIBUTING.md", "site/content/docs/contributing/index.mdx"];

// Every command in the first-run block, in order, on both pages.
const DEV_LOOP = [
  "gh repo clone ashlrai/ashlr-plugin",
  "bun install",
  "bun run typecheck",
  "bun run test",
  "bun run smoke:tools",
  "bun run bench -- --repo . --dry-run",
];

// Scope items each page must name: paths and phrases, not exact sentences.
const BELONGS = [
  "servers/_tool-catalog.json",
  "servers/_genome-*.ts",
  "bun run doctor:sync",
  "site/content/docs/",
  "Windows",
  "benchmark harness",
];
const REJECTED = [
  "@ashlr/core-efficiency",
  "docs/telemetry.md",
  "closed-source",
  "privacy commitments",
  "binaries",
];

function firstShellBlock(text: string): string {
  const match = text.match(/```(?:bash|sh)\n([\s\S]*?)```/);
  expect(match, "page has no shell block").not.toBeNull();
  return match![1];
}

describe("contributor scope and dev loop parity", () => {
  for (const page of PAGES) {
    test(`${page} opens with the shared dev loop`, () => {
      const lines = firstShellBlock(read(page))
        .split("\n")
        .map((line) => line.replace(/\s+#.*$/, "").trim())
        .filter((line) => line && !line.startsWith("cd "));
      expect(lines).toEqual(DEV_LOOP);
    });

    // Plain `bun test` skips the wrapper's derived-docs prep and completion
    // check, so both pages steer whole-suite runs to `bun run test`.
    test(`${page} warns against plain bun test for the whole suite`, () => {
      expect(read(page)).toMatch(/(not|rather than) plain `bun test`/);
    });

    test(`${page} lists the shared scope`, () => {
      const text = read(page);
      for (const item of [...BELONGS, ...REJECTED]) {
        expect(text, `${page} should mention ${item}`).toContain(item);
      }
    });
  }

  test("the dev loop names only real package.json scripts", () => {
    const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;
    for (const line of DEV_LOOP) {
      const name = line.match(/^bun run ([\w:-]+)/)?.[1];
      if (name) expect(scripts[name], `missing script "${name}"`).toBeDefined();
    }
  });

  test("the privacy commitments anchor exists on the Pro page", () => {
    expect(read("site/content/docs/pro/index.mdx")).toContain("\n## Privacy commitments\n");
  });
});
