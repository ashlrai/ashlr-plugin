import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const sources = ["commands/ashlr-parallelize.md", "site/content/docs/skills/parallelize.mdx"];

test("review guide tracks the first shared task and file arguments in both sources", () => {
  const guide = read("docs/parallelize-example-review.md");
  const examples = sources.map((path) => {
    const section = read(path).split("## Examples\n")[1]?.split(/\n## /)[0] ?? "";
    return section.match(/^\/ashlr-parallelize "([^"]+)" (.+)$/m);
  });
  expect(examples[0]).not.toBeNull();
  expect(examples[1]).not.toBeNull();
  expect(examples[1]![0]).toBe(examples[0]![0]);
  expect(guide).toContain(`\`\`\`text\n${examples[0]![0]}\n\`\`\``);
  expect(guide).toContain(`\`${examples[0]![1]}\``);
  for (const file of examples[0]![2].split(/\s+/)) {
    expect(guide).toContain(`\`${file}\``);
    expect(statSync(join(root, file)).isFile()).toBe(true);
  }
  for (const source of sources) expect(guide).toContain(`../${source}#examples`);
  expect(read("docs/README.md")).toContain("(parallelize-example-review.md)");
});

test("review checklist covers the invocation, report, related guides and verification", () => {
  const guide = read("docs/parallelize-example-review.md");
  expect(guide.match(/^- \[ \]/gm)?.length).toBeGreaterThanOrEqual(5);
  for (const item of ["task", "file arguments", "--code", "agent count", "footer", "citations"]) {
    expect(guide).toContain(item);
  }
  for (const path of [
    "parallelize-example-walkthrough.md",
    "parallelize-example-inputs.md",
    "ashlr-command-examples.md",
  ]) {
    expect(guide).toContain(`(${path})`);
    expect(statSync(join(root, "docs", path)).isFile()).toBe(true);
  }
  expect(guide).toContain("__tests__/parallelize-example-review.test.ts");
  expect(guide).toContain("not a record of an actual run");
});
