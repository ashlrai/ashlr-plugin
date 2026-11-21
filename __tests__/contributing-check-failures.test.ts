import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The "When a check fails" table in CONTRIBUTING.md and on the website's
// Contributing page maps each step CI Gate depends on to a local command.
// Keep the step names, the local commands and the secret-scan fixture rule
// tied to ci.yml, package.json and scrub.pl so the table cannot drift.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const PAGES = ["CONTRIBUTING.md", "site/content/docs/contributing/index.mdx"];

// [job, step, local command]
const ROWS: Array<[string, string, string]> = [
  ["fast checks", "Version sync check", "bun run version:check"],
  ["fast checks", "Typecheck", "bun run typecheck"],
  ["fast checks", "Site release facts", "bun run site/scripts/gen-docs.ts --check --skip-corpus"],
  ["Secret-shape scan", "Scan candidate diff (fail closed)", "perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("contributor check-failure guide", () => {
  test("every step the table names exists in its ci.yml job", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const [job, step] of ROWS) {
      const start = ci.search(new RegExp(`^    name: ${escape(job)}$`, "m"));
      expect(start, `ci.yml has no job named "${job}"`).toBeGreaterThan(-1);
      const rest = ci.slice(start + 1);
      const next = rest.search(/^    name: /m);
      const body = next === -1 ? rest : rest.slice(0, next);
      expect(body, `job "${job}" has no step named "${step}"`).toMatch(
        new RegExp(`^      - name: ${escape(step)}$`, "m"),
      );
    }
  });

  test("the local commands match ci.yml and package.json", () => {
    const ci = read(".github/workflows/ci.yml");
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["version:check"]).toBeDefined();
    expect(scripts.typecheck).toBeDefined();
    expect(ci).toContain("run: bun run typecheck");
    expect(ci).toContain("run: bun run site/scripts/gen-docs.ts --check --skip-corpus");
    expect(ci).toContain("perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures");
  });

  test("the documented fixture rule matches scrub.pl", () => {
    const scrub = read(".github/tests/secret-shape/scrub.pl");
    expect(scrub).toContain("(?:tests?|fixtures|benches|examples)/");
    expect(scrub).toContain("_test\\.");
    expect(scrub).toContain("\\.(?:test|spec)\\.");
    expect(scrub).toContain("FAKE|EXAMPLE|DUMMY|TEST|XXXX");
    expect(scrub).toContain("PEM blocks and text outside a diff file are never allowed");
  });

  for (const page of PAGES) {
    test(`${page} carries the check-failure guide`, () => {
      const text = read(page);
      expect(text).toContain("### When a check fails");
      expect(text).toContain("gh run view <run-id> --log-failed");
      for (const [job, step, command] of ROWS) {
        expect(text, `${page} is missing the row for ${step}`).toContain(`| \`${job}\`: \`${step}\` |`);
        expect(text).toContain(command);
      }
      expect(text).toContain("`FAKE`, `EXAMPLE`, `DUMMY`, `TEST` or `XXXX`");
      expect(text).toContain("gh pr view <pr-number> --json autoMergeRequest");
    });
  }
});
