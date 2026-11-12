/**
 * Every public "N slash commands" claim equals the number of Markdown files in
 * commands/, the same definition .claude-plugin/plugin.json, product-metadata
 * and the generated site pages use. /goal and /loop are not ashlr-prefixed but
 * are shipped commands, so an ashlr-* only count drifts from the manifest.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const count = readdirSync(join(root, "commands")).filter((name) => name.endsWith(".md")).length;

const files = [
  "README.md",
  "llms.txt",
  "docs/billing.md",
  "docs/competitive-wozcode.md",
  "docs/launch-post.md",
  "docs/press-kit/fact-sheet.md",
  "docs/pricing.md",
  "docs/social.md",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "site/content/docs/index.mdx",
  "site/content/docs/getting-started/index.mdx",
  "site/content/docs/pro/index.mdx",
  "site/content/docs/pro/pricing.mdx",
  "site/content/docs/skills/index.mdx",
  "site/content/docs/skills/help.mdx",
];

describe("slash command count claims", () => {
  for (const file of files) {
    test(`${file} matches commands/*.md`, () => {
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/(\d+) (?:Claude Code |shipped )?slash commands/g)) {
        expect(Number(match[1]), `${file}: "${match[0]}"`).toBe(count);
      }
    });
  }

  test("generated site pages exist for the non-ashlr-prefixed commands", () => {
    for (const name of ["goal", "loop"]) {
      expect(readFileSync(join(root, `site/content/docs/skills/${name}.mdx`), "utf8")).toContain(`/${name}`);
    }
  });
});
