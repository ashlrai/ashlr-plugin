import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("parallelize input walkthrough stays anchored to the first command example", () => {
  const source = read("commands/ashlr-parallelize.md");
  const doc = read("docs/parallelize-example-inputs.md");
  const example = source.split("## Examples\n")[1]?.match(/^\/ashlr-parallelize "([^"]+)" (.+)$/m);
  expect(example).toBeDefined();
  const [, task, fileArgs] = example!;
  const files = fileArgs.split(/\s+/);
  expect(files).toHaveLength(2);
  expect(doc).toContain(`\`\`\`text\n${example![0]}\n\`\`\``);
  expect(doc).toContain(`\`${task}\``);
  for (const file of files) {
    expect(doc).toContain(`\`${file}\``);
    expect(statSync(join(root, file)).isFile()).toBe(true);
  }
  expect(doc).toContain("`ashlr:ashlr:explore`");
  expect(doc).toContain("does not establish");
  expect(read("docs/README.md")).toContain("(parallelize-example-inputs.md)");
  expect(read("docs/ashlr-command-examples.md")).toContain("(parallelize-example-inputs.md)");
});

test("the walkthrough expands the command's prompt template once per input file", () => {
  const source = read("commands/ashlr-parallelize.md");
  const doc = read("docs/parallelize-example-inputs.md");
  const example = source.split("## Examples\n")[1]?.match(/^\/ashlr-parallelize "([^"]+)" (.+)$/m);
  const template = source.match(/For each file, construct an agent prompt:\n\s+```\n([\s\S]*?)\n\s+```/)?.[1]
    .split("\n").map((line) => line.replace(/^   /, "")).join("\n");
  expect(example).toBeDefined();
  expect(template).toBeDefined();

  const prompts = [...doc.matchAll(/```text\n(Task: [\s\S]*?)\n```/g)].map((match) => match[1]);
  const expected = example![2].split(/\s+/).map((file) =>
    template!.replace("<task>", example![1]).replace("<file_path>", file));
  expect(prompts).toEqual(expected);
});
