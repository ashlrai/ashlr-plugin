import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function firstExampleFiles(source: string): string[] {
  const examples = source.split("## Examples\n")[1]?.split("\n## ")[0];
  const invocation = examples?.match(/^\/ashlr-parallelize "[^"]+"\s+(.+)$/m);
  if (!invocation) throw new Error("Missing first parallelize example");

  const files = invocation[1].trim().split(/\s+/);
  if (files.length !== 2 || new Set(files).size !== 2 || files.some((file) => !/[/.]/.test(file) && !file.startsWith("__"))) {
    throw new Error("First parallelize example must name two distinct input files");
  }
  return files.sort();
}

test("command and site first examples name the same two input files", () => {
  const commandFiles = firstExampleFiles(read("commands/ashlr-parallelize.md"));
  const siteFiles = firstExampleFiles(read("site/content/docs/skills/parallelize.mdx"));
  expect(siteFiles).toEqual(commandFiles);
});

test("first example input extraction rejects missing or invalid examples", () => {
  for (const source of [
    "## Examples\nNo invocation here.\n",
    '## Examples\n/ashlr-parallelize "task" one.ts\n',
    '## Examples\n/ashlr-parallelize "task" one.ts one.ts\n',
    '## Examples\n/ashlr-parallelize "task" one.ts two.ts three.ts\n',
    '## Examples\n/ashlr-parallelize "task" one.ts --code\n',
  ]) {
    expect(() => firstExampleFiles(source)).toThrow();
  }
  expect(firstExampleFiles('## Examples\n/ashlr-parallelize "task" b.ts a.ts\n'))
    .toEqual(["a.ts", "b.ts"]);
});

test("the TODO example names existing hook files", () => {
  const examples = read("commands/ashlr-parallelize.md").split("## Examples\n")[1]?.split("\n## ")[0];
  const invocation = examples?.match(/^\/ashlr-parallelize "find all TODO comments and summarize them" (.+)$/m);
  expect(invocation).toBeDefined();

  const files = invocation![1].split(/\s+/);
  expect(files).toEqual(["hooks/pretooluse-read.ts", "hooks/pretooluse-bash.ts"]);
  for (const file of files) {
    expect(statSync(join(root, file)).isFile()).toBe(true);
  }
});

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
