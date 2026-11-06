import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("parallelize TODO example references existing hook files", () => {
  const command = readFileSync(join(root, "commands/ashlr-parallelize.md"), "utf8");
  const example = command.match(/^\/ashlr-parallelize "find all TODO comments and summarize them" (.+)$/m);
  expect(example).not.toBeNull();

  const paths = example![1].split(/\s+/);
  expect(paths).toEqual(["hooks/pretooluse-read.ts", "hooks/pretooluse-bash.ts"]);
  for (const path of paths) {
    expect(statSync(join(root, path)).isFile()).toBe(true);
  }
});
