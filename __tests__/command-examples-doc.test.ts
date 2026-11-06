import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const examples = readFileSync(join(root, "docs/command-examples.md"), "utf8");
const table = readme.match(/\| Task \| Terminal \| Claude Code \|\n(?:\|[^\n]+\n)+/)?.[0] ?? "";
const commands = [...table.matchAll(/`((?:ashlr-plugin |\/ashlr-)[^`]+)`/g)]
  .map((match) => match[1]);

test("README command table contains terminal and slash commands", () => {
  expect(commands.some((command) => command.startsWith("ashlr-plugin "))).toBe(true);
  expect(commands.some((command) => command.startsWith("/ashlr-"))).toBe(true);
  expect(new Set(commands).size).toBe(commands.length);
});

for (const command of commands) {
  test(`${command} links to a documented output example`, () => {
    const anchor = command.replace(/[^a-z0-9 -]/g, "").replaceAll(" ", "-");
    expect(table).toContain(`[\`${command}\`](docs/command-examples.md#${anchor})`);
    const section = examples.split(`### \`${command}\`\n`)[1]?.split("\n### ")[0];
    expect(section).toBeDefined();
    const output = section?.match(/```(?:text|json)\n([\s\S]*?)\n```/)?.[1];
    expect(output?.trim().length ?? 0).toBeGreaterThan(0);
    expect(output?.trim()).not.toBe(command);
    if (section?.includes("```json")) expect(() => JSON.parse(output!)).not.toThrow();
  });
}
