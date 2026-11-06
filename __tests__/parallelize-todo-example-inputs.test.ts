import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("TODO input guide identifies the command example's task and every file", () => {
  const command = read("commands/ashlr-parallelize.md");
  const examples = command.split("## Examples\n")[1]?.split("\n## Steps")[0];
  const example = examples?.match(/^\/ashlr-parallelize "(find all TODO comments and summarize them)" (.+)$/m);
  expect(example).toBeTruthy();

  const [, task, fileArgs] = example!;
  const files = fileArgs.split(/\s+/);
  expect(files).toHaveLength(2);
  const guide = read("docs/parallelize-todo-example-inputs.md");
  expect(guide).toContain(`\`\`\`text\n${example![0]}\n\`\`\``);
  expect(guide).toContain(`| \`${task}\` | The quoted task prompt shared by each agent. |`);
  for (const file of files) {
    expect(guide).toContain(`| \`${file}\` |`);
    expect(statSync(join(root, file)).isFile()).toBe(true);
  }
  expect(guide).toContain("`ashlr:ashlr:explore`");
  expect(guide).toContain("does not describe the hooks' own");
  expect(guide).toContain("../commands/ashlr-parallelize.md#examples");
  expect(read("docs/README.md")).toContain("(parallelize-todo-example-inputs.md)");
});
