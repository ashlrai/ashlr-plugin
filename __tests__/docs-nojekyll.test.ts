import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// GitHub's pages-build-deployment runs Jekyll over docs/ unless .nojekyll is
// present. docs/platform-support.md quotes `${{ hashFiles('bun.lock') }}`,
// which is invalid Liquid and fails the build.
test("docs/ opts out of Jekyll with .nojekyll", () => {
  expect(existsSync(join(import.meta.dir, "..", "docs", ".nojekyll"))).toBe(true);
});
