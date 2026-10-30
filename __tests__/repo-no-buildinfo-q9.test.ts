import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("no TypeScript build info is tracked", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.tsbuildinfo"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean);

  expect(tracked).toEqual([]);
});
