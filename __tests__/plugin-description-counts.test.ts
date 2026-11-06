import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");

// Counts as the plugin ships them by default. Tools gated behind an env flag
// (enableEnv, e.g. the experimental pipe server) are not part of the default
// surface, so the description does not count them.
const defaultOnToolCount = catalog.filter((tool) => !("enableEnv" in tool) || !tool.enableEnv).length;

// The plugin description counts all command Markdown files.
const commandFiles = await readdir(join(ROOT, "commands"));
const slashCommandCount = commandFiles.filter((name) => name.endsWith(".md")).length;

const description = JSON.parse(
  await readFile(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"),
).description as string;

describe("plugin.json description counts", () => {
  test("real counts are non-zero", () => {
    expect(defaultOnToolCount).toBeGreaterThan(0);
    expect(slashCommandCount).toBeGreaterThan(0);
  });

  test("description names the MCP tool count and slash command count", () => {
    expect(description).toMatch(/\d+ MCP tools and \d+ slash commands/);
  });

  test("MCP tool count in description equals the default-on tool catalog", () => {
    const named = Number(description.match(/(\d+) MCP tools/)?.[1]);
    expect({ description: named, catalog: defaultOnToolCount }).toEqual({
      description: defaultOnToolCount,
      catalog: defaultOnToolCount,
    });
  });

  test("slash command count in description equals the Markdown files in commands/", () => {
    const named = Number(description.match(/(\d+) slash commands/)?.[1]);
    expect({ description: named, commands: slashCommandCount }).toEqual({
      description: slashCommandCount,
      commands: slashCommandCount,
    });
  });
});
