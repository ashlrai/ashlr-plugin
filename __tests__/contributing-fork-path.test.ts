import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keeps the first-time contributor path (CONTRIBUTING.md and the website's
// Contributing pages) tied to the files it describes: the fork commands, the
// docs-only path list that ci.yml's "Classify changes" step uses, the secret
// scan flags, the quoted test-file count, and the anchors other docs link to.
// contributing-merge-rules.test.ts covers the merge rules themselves.

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const CONTRIBUTING = "CONTRIBUTING.md";
const SITE_INDEX = "site/content/docs/contributing/index.mdx";
const SITE_TESTING = "site/content/docs/contributing/testing.mdx";
const PAGES = [CONTRIBUTING, SITE_INDEX];

// GitHub-style heading slug: lowercase, drop punctuation, spaces to hyphens.
function slugs(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    out.add(
      match[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s/g, "-"),
    );
  }
  return out;
}

describe("contributor fork path", () => {
  for (const page of PAGES) {
    test(`${page} gives the fork commands and the fork base for the pre-merge check`, () => {
      const text = read(page);
      expect(text).toContain("## Contribute from a fork with your own agent");
      expect(text).toContain("gh repo fork ashlrai/ashlr-plugin --clone");
      expect(text).toContain("git push -u origin fix/<topic>");
      expect(text).toContain(
        "gh pr create --repo ashlrai/ashlr-plugin --base main --head <your-github-user>:fix/<topic> --fill",
      );
      expect(text).toContain("bun scripts/premerge-local.ts upstream/main");
      expect(text).toContain("You cannot arm auto-merge on a fork PR");
    });

    test(`${page} names the secret scan the way scrub.pl parses it`, () => {
      const text = read(page);
      const command =
        "git diff origin/main...HEAD | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures";
      expect(text).toContain(command);
      const scrub = read(".github/tests/secret-shape/scrub.pl");
      // --check must be the first argument; --allow-fixtures may follow it.
      expect(scrub).toContain("$ARGV[0] eq '--check'");
      expect(scrub).toContain("$_ eq '--allow-fixtures'");
    });
  }

  // The docs list the paths a docs-only PR may touch. If ci.yml's classifier
  // changes, this fails so the list in all three pages is updated with it.
  test("the docs-only path list matches ci.yml's classifier", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("grep -Ev '^(docs/|site/|video/|[^/]*\\.md$|LICENSE$|\\.github/ISSUE_TEMPLATE/)'");
    for (const page of [...PAGES, SITE_TESTING]) {
      const text = read(page);
      expect(text, `${page} must list the docs-only paths ci.yml uses`).toContain(
        "`docs/`, `site/`, `video/`, top-level Markdown, `LICENSE` or issue templates",
      );
    }
  });

  test("the test-file count on the Testing page is within 10% of the tree", () => {
    const text = read(SITE_TESTING);
    const quoted = Number(text.match(/under `__tests__\/` \(about (\d+) files\)/)?.[1]);
    expect(Number.isFinite(quoted)).toBe(true);
    const actual = readdirSync(join(root, "__tests__"), { recursive: true }).filter((f) =>
      String(f).endsWith(".test.ts"),
    ).length;
    expect(Math.abs(quoted - actual) / actual, `quoted ${quoted}, tree has ${actual}`).toBeLessThanOrEqual(0.1);
  });

  test("links into CONTRIBUTING.md and AGENTS.md point at real headings", () => {
    const targets: Record<string, Set<string>> = {
      "CONTRIBUTING.md": slugs(read(CONTRIBUTING)),
      "AGENTS.md": slugs(read("AGENTS.md")),
    };
    const sources = [
      "README.md",
      "AGENTS.md",
      "llms.txt",
      "llms-full.txt",
      ".github/PULL_REQUEST_TEMPLATE.md",
      CONTRIBUTING,
      SITE_INDEX,
      SITE_TESTING,
    ];
    let checked = 0;
    for (const source of sources) {
      for (const match of read(source).matchAll(/(CONTRIBUTING\.md|AGENTS\.md)#([a-z0-9-]+)/g)) {
        checked++;
        expect(targets[match[1]].has(match[2]), `${source} links to missing ${match[1]}#${match[2]}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("the Contributing page's links into the Testing page point at real headings", () => {
    const testing = slugs(read(SITE_TESTING));
    const links = [...read(SITE_INDEX).matchAll(/\/docs\/contributing\/testing#([a-z0-9-]+)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, anchor] of links) {
      expect(testing.has(anchor), `missing /docs/contributing/testing#${anchor}`).toBe(true);
    }
  });
});
