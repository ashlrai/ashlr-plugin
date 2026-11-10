import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

import {
  PUBLIC_PRODUCT_COUNTS,
  publicProductCounts,
} from "../scripts/product-metadata";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(path)) as Record<string, unknown>;
}

interface ProductNameEntry {
  path: string;
  value: unknown;
}

const PRODUCT_NAME_MANIFESTS = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "server.json",
  "glama.json",
] as const;

function productNameEntries(file: string, doc: Record<string, unknown>): ProductNameEntry[] {
  const at = (path: string, value: unknown): ProductNameEntry => ({ path: `${file}#${path}`, value });
  const plugins = Array.isArray(doc.plugins) ? doc.plugins : [];
  const pluginNames = plugins.map((plugin, index) =>
    at(`plugins[${index}].name`, (plugin as Record<string, unknown>).name),
  );
  const codexInterface = doc.interface as Record<string, unknown> | undefined;

  switch (file) {
    case "package.json":
      return [at("name", doc.name), at("mcpName", doc.mcpName)];
    case ".claude-plugin/plugin.json":
      return [at("name", doc.name)];
    case ".codex-plugin/plugin.json":
      return [at("name", doc.name), at("interface.displayName", codexInterface?.displayName)];
    case ".claude-plugin/marketplace.json":
    case ".agents/plugins/marketplace.json":
      return [at("name", doc.name), ...pluginNames];
    case "server.json":
      return [at("name", doc.name), at("title", doc.title)];
    case "glama.json":
      return [at("name", doc.name)];
    default:
      return [];
  }
}

describe("public product metadata", () => {
  test("published counts are positive integers", () => {
    for (const count of [PUBLIC_PRODUCT_COUNTS.mcpTools, PUBLIC_PRODUCT_COUNTS.slashCommands]) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
  });

  test("calculated counts expose numeric values and are repeatable", async () => {
    const first = await publicProductCounts();
    const second = await publicProductCounts();

    expect(typeof first.mcpTools).toBe("number");
    expect(typeof first.slashCommands).toBe("number");
    expect(second).toEqual(first);
  });

  test("published counts match registered tools and shipped slash commands", async () => {
    await expect(publicProductCounts()).resolves.toEqual(PUBLIC_PRODUCT_COUNTS);
  });

  test("primary public copy uses current counts and opt-in telemetry wording", async () => {
    const files = await Promise.all([
      read("README.md"),
      read(".claude-plugin/plugin.json"),
      read(".codex-plugin/plugin.json"),
      read(".claude-plugin/marketplace.json"),
      read("site/content/docs/index.mdx"),
      read("site/content/docs/pro/pricing.mdx"),
    ]);
    const combined = files.join("\n");

    expect(combined).toContain(`${PUBLIC_PRODUCT_COUNTS.mcpTools} MCP tools`);
    expect(combined).toContain(`${PUBLIC_PRODUCT_COUNTS.slashCommands} slash commands`);
    expect(combined).toContain("opt-in telemetry");
    expect(combined).not.toContain("30 slash commands");
    expect(combined).not.toContain("30 skills");
    expect(combined).not.toContain("zero telemetry");
  });

  test("required product names are nonempty strings", async () => {
    for (const file of PRODUCT_NAME_MANIFESTS) {
      const entries = productNameEntries(file, await readJson(file));
      expect(entries.length).toBeGreaterThan(0);
      for (const { path, value } of entries) {
        expect(typeof value, `${path} must be a string`).toBe("string");
        expect((value as string).trim().length, `${path} must not be blank`).toBeGreaterThan(0);
      }
    }
  });
});
