import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The "PR checklist" in CONTRIBUTING.md and on the website's Contributing page
// must ask for every check the PR template asks for, so a contributor who reads
// either page ticks the same boxes the template shows them. Every script either
// checklist names must exist in package.json.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const PAGES = ["CONTRIBUTING.md", "site/content/docs/contributing/index.mdx"];
const TEMPLATE = ".github/PULL_REQUEST_TEMPLATE.md";

// Checks the PR template asks for; each must also appear in both checklists.
const SHARED = [
  "bun scripts/premerge-local.ts origin/main",
  "`upstream/main` from a fork",
  "perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures",
  "`upstream/main...HEAD` from a fork",
  "bun run references:sync",
  "bun run references:check",
  "bun run doctor:sync",
  ".claude-plugin/install-manifest.json",
  "bun run version:check",
  "CHANGELOG.md",
  "Unreleased",
  "telemetry without an opt-in",
  "__tests__/pipe-server-<topic>.test.ts",
  "site/lib/docs.generated.json",
];

function checklist(page: string): string {
  const text = read(page);
  const start = text.indexOf("\n## PR checklist\n");
  expect(start, `${page} has no "## PR checklist" section`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("contributor PR checklist", () => {
  test("the PR template still asks for every shared check", () => {
    const template = read(TEMPLATE);
    for (const item of SHARED) {
      expect(template, `${TEMPLATE} should mention ${item}`).toContain(item);
    }
  });

  for (const page of PAGES) {
    test(`${page} asks for every check the PR template does`, () => {
      const section = checklist(page);
      for (const item of SHARED) {
        expect(section, `${page} PR checklist should mention ${item}`).toContain(item);
      }
      expect(section).toContain("PULL_REQUEST_TEMPLATE.md");
    });

    test(`${page} names only real package.json scripts`, () => {
      const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;
      // Root scripts only: `cd site && ... bun run check` starts with `cd`, so it is not matched.
      const named = [...checklist(page).matchAll(/`bun run ([\w:-]+)/g)].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      for (const name of named) {
        expect(scripts[name], `${page} names missing script "${name}"`).toBeDefined();
      }
    });
  }
});
