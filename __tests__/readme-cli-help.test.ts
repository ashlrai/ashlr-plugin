import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("README CLI signatures match the executable help", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/ashlr-plugin.mjs"), "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const help = result.stdout + result.stderr;
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.split("### CLI options\n")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  const signatures = (text: string) => text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ashlr-plugin "));
  expect(signatures(section!)).toEqual(signatures(help));
});
