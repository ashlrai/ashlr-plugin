import { expect, test } from "bun:test";
import { buildCatalog, type CatalogTool } from "../scripts/gen-tool-catalog";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

function expectCompactDescriptions(tools: CatalogTool[]) {
  const alwaysOn = tools.filter((tool) => !("enableEnv" in tool) || !tool.enableEnv);
  expect(alwaysOn.length).toBeGreaterThan(0);

  const invalid = alwaysOn.flatMap((tool) => {
    const description: unknown = tool.description;
    if (typeof description !== "string" || !description.trim()) {
      return [`${tool.name}: empty or missing description`];
    }
    return description.length > 200 ? [`${tool.name}: ${description.length} characters`] : [];
  });
  expect(invalid).toEqual([]);
}

test("always-on tools have nonempty descriptions of at most 200 characters", () => {
  expectCompactDescriptions(catalog);
});

test("live always-on registrations also meet the 200-character description budget", async () => {
  expectCompactDescriptions(await buildCatalog());
});
