import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("notebook edit reference documents the registered arguments", () => {
  const docs = readFileSync("site/content/docs/tools/notebook-edit.mdx", "utf8");
  const catalog = JSON.parse(readFileSync("servers/_tool-catalog.json", "utf8"));
  const tool = catalog.find((entry: { name: string }) => entry.name === "ashlr__notebook_edit");
  expect(tool).toBeDefined();
  for (const name of Object.keys(tool.inputSchema.properties)) {
    expect(docs).toContain(`\`${name}\``);
  }
  expect(docs).toContain("removes outputs and execution count");
});
