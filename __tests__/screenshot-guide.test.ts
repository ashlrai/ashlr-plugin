import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the screenshot guide's dashboard command runs from the checkout", () => {
  const guide = readFileSync(join(root, "docs/press-kit/screenshots.md"), "utf8");
  const section = guide.split("\n").find((line) => line.includes("**Savings dashboard:**"));
  expect(section).toBeDefined();
  const command = section!.match(/`bun run (scripts\/[^\s`]+) --watch`/);
  expect(command).not.toBeNull();
  const result = Bun.spawnSync([process.execPath, "run", command![1], "--watch"], {
    cwd: root,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().length).toBeGreaterThan(0);
});
