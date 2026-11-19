import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keeps the contributor-facing merge rules (CONTRIBUTING.md and the website's
// Contributing page) tied to the repository files they describe. The ruleset
// itself lives in GitHub settings and cannot be read offline, so this checks
// the parts that are in the tree: job names, CODEOWNERS coverage, and that
// both pages carry the same merge-rules paragraph.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const CONTRIBUTING = "CONTRIBUTING.md";
const SITE_PAGE = "site/content/docs/contributing/index.mdx";
const PAGES = [CONTRIBUTING, SITE_PAGE];

describe("contributor merge rules", () => {
  test("the jobs the docs name exist in ci.yml", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const job of ["fast checks", "Secret-shape scan", "CI Gate"]) {
      expect(ci, `ci.yml has no job named "${job}"`).toMatch(new RegExp(`^\\s+name: ${job}$`, "m"));
    }
  });

  test("CODEOWNERS covers the path classes the docs list", () => {
    expect(existsSync(join(root, ".github/CODEOWNERS"))).toBe(true);
    const owners = read(".github/CODEOWNERS");
    expect(owners).toMatch(/^\/\.github\/workflows\/\s/m);
    expect(owners).toMatch(/^\/\.github\/tests\/secret-shape\/\s/m);
    expect(owners).toMatch(/keyed, network or loopback requests/);
  });

  for (const page of PAGES) {
    test(`${page} explains review, squash merge and CODEOWNERS`, () => {
      const text = read(page);
      expect(text).toContain("`CI Gate`");
      expect(text).toContain("No approving review is required");
      expect(text).toContain("squash-merges each PR, so the PR title becomes the commit subject");
      expect(text).toMatch(/\[`\.github\/CODEOWNERS`\]\([^)]*\.github\/CODEOWNERS\)/);
    });
  }
});
