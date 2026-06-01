import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("plugin metadata", () => {
  test("package, plugin, and marketplace versions stay in sync", async () => {
    const pkg = await readJson<{ version: string }>("package.json");
    const plugin = await readJson<{ version: string }>(".claude-plugin/plugin.json");
    const marketplace = await readJson<{
      metadata: { version: string };
      plugins: Array<{ name: string; version: string }>;
    }>(".claude-plugin/marketplace.json");
    const entry = marketplace.plugins.find((p) => p.name === "ashlr");

    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(entry?.version).toBe(pkg.version);
  });

  test("marketplace copy matches the current tool count and telemetry posture", async () => {
    const marketplace = await readJson<{
      metadata: { description: string };
      plugins: Array<{ name: string; description: string }>;
    }>(".claude-plugin/marketplace.json");
    const plugin = await readJson<{ description: string }>(".claude-plugin/plugin.json");
    const entry = marketplace.plugins.find((p) => p.name === "ashlr");

    expect(marketplace.metadata.description).toContain("40 token-efficient MCP tools");
    expect(marketplace.metadata.description).toContain("34 slash commands");
    expect(marketplace.metadata.description).toContain("opt-in telemetry");
    expect(entry?.description).toContain("Mean -57% savings overall");
    expect(plugin.description).toContain("40 MCP tools and 34 slash commands");
    expect(plugin.description).toContain("opt-in telemetry");
    expect(plugin.description).not.toContain("zero telemetry");
  });
});
