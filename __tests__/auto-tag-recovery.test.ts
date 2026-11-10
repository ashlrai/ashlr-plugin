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

describe("fast gate release facts", () => {
  test("the fast job rejects stale site release facts before a tag can be cut", () => {
    const fast = ci.slice(ci.indexOf("\n  fast:"), ci.indexOf("\n  linux:"));
    expect(fast).toContain("bun run site/scripts/gen-docs.ts --check --skip-corpus");
    expect(fast).not.toContain("site/lib/docs.generated.json");
  });
});

describe("fast gate resilience", () => {
  test("the fast job retries a transient setup-bun failure once", () => {
    const fast = ci.slice(ci.indexOf("\n  fast:"), ci.indexOf("\n  linux:"));
    expect(fast).toMatch(/id: bun\n\s+uses: oven-sh\/setup-bun@[0-9a-f]{40}[^\n]*\n\s+continue-on-error: true/);
    expect(fast).toContain("if: steps.bun.outcome == 'failure'");
    expect(fast.match(/oven-sh\/setup-bun@[0-9a-f]{40}/g)).toHaveLength(2);
  });
});

describe("auto-tag API resilience", () => {
  test("the manifest version read retries transient API failures", () => {
    const fn = tag.slice(tag.indexOf("read_version() {"), tag.indexOf("new=$(read_version"));
    expect(fn).toContain("for attempt in 1 2 3 4");
    expect(fn).toContain("return 1");
  });
});
