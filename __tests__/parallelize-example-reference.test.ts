import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const locations = ["commands/ashlr-parallelize.md", "site/content/docs/skills/parallelize.mdx"];

const todoInvocation = (doc: string) =>
  doc.split("## Examples\n")[1]?.split(/\n## /)[0]
    .match(/^\/ashlr-parallelize "find all TODO comments and summarize them" .+$/m)?.[0];

test("reference names the TODO example and its input files from both locations", () => {
  const ref = read("docs/parallelize-example-reference.md");
  const invocations = locations.map((l) => todoInvocation(read(l)));
  expect(invocations[0]).toBeTruthy();
  expect(invocations[1]).toBe(invocations[0]);
  expect(ref).toContain(`\`\`\`text\n${invocations[0]}\n\`\`\``);

  const [, task, fileArgs] = invocations[0]!.match(/^\/ashlr-parallelize "([^"]+)" (.+)$/)!;
  expect(ref).toContain(`| \`${task}\` |`);
  for (const file of fileArgs.split(/\s+/)) {
    expect(ref).toContain(`| \`${file}\` |`);
    expect(statSync(join(root, file)).isFile()).toBe(true);
  }
  for (const l of locations) expect(ref).toContain(`(../${l}`);
  expect(read("docs/README.md")).toContain("(parallelize-example-reference.md)");
});
