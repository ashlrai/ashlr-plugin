import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readVersion = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version;

test("Claude plugin version matches package version", () => {
  const packageVersion = readVersion("../package.json");
  const pluginVersion = readVersion("../.claude-plugin/plugin.json");

  expect(typeof packageVersion).toBe("string");
  expect(packageVersion).not.toBe("");
  expect(pluginVersion).toBe(packageVersion);
});
