import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const tag = readFileSync(".github/workflows/auto-tag.yml", "utf8");

describe("automatic release recovery", () => {
  test("main pushes produce the CI run that triggers reconciliation", () => {
    expect(ci).toMatch(/\n  push:\n    branches: \[main\]/);
    expect(tag).toContain('github.event.workflow_run.event == \'push\'');
    expect(tag).toContain('workflows: ["ci"]');
  });

  test("a missing tag is considered even when the version did not change", () => {
    expect(tag).toContain('refs/tags/v$new');
    expect(tag).not.toContain('"$new" = "$old"');
    expect(tag).toContain('repos/$REPO/commits/$BRANCH');
    expect(tag).toContain('steps.create_tag.outputs.exists == \'true\'');
  });
});
