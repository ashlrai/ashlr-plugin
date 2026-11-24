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

    test(`${page} names the local pre-merge check the script actually implements`, () => {
      const text = read(page);
      expect(text).toContain("bun scripts/premerge-local.ts origin/main");
      expect(text).toContain("`--budget-ms <n>`");
      expect(text).toContain("60-second budget");
    });
  }

  test("the documented pre-merge usage, budget and verdict match the script", () => {
    const script = read("scripts/premerge-local.ts");
    expect(script).toContain("Usage: bun scripts/premerge-local.ts <base> [--budget-ms <n>]");
    expect(script).toMatch(/DEFAULT_BUDGET_MS = 60_000;/);
    expect(script).toContain('kind: "ashlr.premerge-local"');
    const testing = read("site/content/docs/contributing/testing.mdx");
    expect(testing).toContain("## Run what your branch affects");
    expect(testing).toContain('"kind":"ashlr.premerge-local"');
  });

  // ci.yml's "Classify changes" step applies the docs-only skip only to the
  // pull_request event; every other event (merge_group included) forces
  // code=true. The docs must not promise a docs-only PR lands without the
  // install, typecheck and release-facts steps.
  test("the docs-only skip is documented as PR-run only, matching ci.yml", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain('if [ "$EVENT" != "pull_request" ]; then echo "code=true" >> "$GITHUB_OUTPUT"; else');
    for (const page of [...PAGES, "site/content/docs/contributing/testing.mdx"]) {
      const text = read(page);
      expect(text, `${page} must say the docs-only skip applies to the PR run`).toMatch(/On the PR run|the PR run of `fast checks`/);
      expect(text, `${page} must say the merge queue run always does the full fast checks`).toMatch(
        /merge queue (?:and `main` )?runs? always/,
      );
    }
  });
});
