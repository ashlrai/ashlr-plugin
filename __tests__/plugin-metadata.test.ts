import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "fs/promises";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("plugin metadata", () => {
  test("package, plugin, and marketplace versions stay in sync", async () => {
    const pkg = await readJson<{ version: string }>("package.json");
    const plugin = await readJson<{ version: string }>(".claude-plugin/plugin.json");
    const codexPlugin = await readJson<{ version: string }>(".codex-plugin/plugin.json");
    const marketplace = await readJson<{
      metadata: { version: string };
      plugins: Array<{ name: string; version: string }>;
    }>(".claude-plugin/marketplace.json");
    const entry = marketplace.plugins.find((p) => p.name === "ashlr");

    expect(plugin.version).toBe(pkg.version);
    expect(codexPlugin.version).toBe(pkg.version);
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(entry?.version).toBe(pkg.version);
  });

  test("release version scripts include the Codex plugin manifest", async () => {
    const bump = await readFile("scripts/bump-version.ts", "utf8");
    const check = await readFile("scripts/check-version-sync.ts", "utf8");

    expect(bump).toContain(".codex-plugin/plugin.json");
    expect(check).toContain(".codex-plugin/plugin.json#version");
  });

  test("every slash command and workflow skill has a non-empty one-line description", async () => {
    // Claude Code and the site generator both read frontmatter `description:`.
    // Parse it as real YAML so folded (`>`) blocks and stray `: ` fail here.
    const MAX_CHARS = 200;
    const files = (await readdir("commands")).filter((name) => name.endsWith(".md")).sort();
    const skillDirs = (await readdir("skills", { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `skills/${entry.name}/SKILL.md`)
      .sort();
    const problems: string[] = [];

    for (const path of [...files.map((name) => `commands/${name}`), ...skillDirs]) {
      const source = await readFile(path, "utf8");
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
      if (frontmatter === undefined) {
        problems.push(`${path}: missing frontmatter`);
        continue;
      }
      const meta = Bun.YAML.parse(frontmatter) as { description?: unknown } | null;
      const description = typeof meta?.description === "string" ? meta.description.trim() : "";
      if (!description) problems.push(`${path}: description is empty`);
      else if (/[\r\n]/.test(description)) problems.push(`${path}: description spans multiple lines`);
      else if (description.length > MAX_CHARS) problems.push(`${path}: description is ${description.length} chars (max ${MAX_CHARS})`);
    }

    expect(problems).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  test("marketplace copy matches the current tool count and telemetry posture", async () => {
    const marketplace = await readJson<{
      metadata: { description: string };
      plugins: Array<{ name: string; description: string }>;
    }>(".claude-plugin/marketplace.json");
    const plugin = await readJson<{ description: string }>(".claude-plugin/plugin.json");
    const codexPlugin = await readJson<{ description: string }>(".codex-plugin/plugin.json");
    const entry = marketplace.plugins.find((p) => p.name === "ashlr");
    const commands = await readdir("commands");
    // Every commands/*.md is a slash command (goal.md and loop.md carry no
    // ashlr- prefix), so one count backs both the marketplace and plugin copy.
    const slashCount = commands.filter((name) => name.endsWith(".md")).length;
    const toolCount = (await readJson<Array<{ enableEnv?: string }>>("servers/_tool-catalog.json"))
      .filter((tool) => !tool.enableEnv).length;

    expect(marketplace.metadata.description).toContain(`${toolCount} token-efficient MCP tools`);
    expect(marketplace.metadata.description).toContain(`${slashCount} slash commands`);
    expect(marketplace.metadata.description).toContain("opt-in telemetry");
    expect(entry?.description).toContain("reads about -75%");
    expect(plugin.description).toContain(`${toolCount} MCP tools and ${slashCount} slash commands`);
    expect(codexPlugin.description).toContain(`${toolCount} MCP tools`);
    expect(codexPlugin.description).toContain("Codex skills");
    expect(plugin.description).toContain("opt-in telemetry");
    expect(plugin.description).not.toContain("zero telemetry");
  });
});
