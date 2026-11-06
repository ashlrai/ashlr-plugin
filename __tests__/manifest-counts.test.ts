import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("manifest slash command count matches command files", () => {
  const { description } = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")) as { description: string };
  const match = description.match(/(\d+) slash commands/);
  const commandCount = readdirSync(join(root, "commands"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;

  expect(match).not.toBeNull();
  expect(Number(match?.[1])).toBe(commandCount);
});
