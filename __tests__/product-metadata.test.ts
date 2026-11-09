import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

import {
  PUBLIC_PRODUCT_COUNTS,
  publicProductCounts,
} from "../scripts/product-metadata";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
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
});
