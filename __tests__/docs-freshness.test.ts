import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { declaredToolNames } from "../scripts/gen-tool-catalog";
import catalog from "../servers/_tool-catalog.json";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const docs = "site/content/docs/";
const publicTools = catalog.filter((tool) => !("enableEnv" in tool));
const names = (text: string) => [...new Set(text.match(/ashlr__[a-z0-9_]+/g))].sort();

test("documented tool inventories match handler declarations and catalog", () => {
  const imports = [...read("servers/_router-handlers.ts").matchAll(/^import "\.\/([a-z0-9-]+-server-handlers)";/gm)];
  expect(imports.length).toBeGreaterThan(0);
  const declared = imports.flatMap((match) => declaredToolNames(read(`servers/${match[1]}.ts`))).sort();
  expect(declared).toEqual(catalog.map((tool) => tool.name).sort());
  for (const page of ["tools/index.mdx", "tools/capabilities.mdx"]) {
    expect(names(read(docs + page))).toEqual(catalog.map((tool) => tool.name).sort());
  }
  const rows = read(docs + "tools/capabilities.mdx").split("\n").filter((line) => /^\| `ashlr__/.test(line));
  expect(rows.map((row) => names(row)[0]).sort()).toEqual(publicTools.map((tool) => tool.name).sort());
  for (const tool of catalog) {
    const slug = tool.name.replace("ashlr__", "").replaceAll("_", "-");
    expect(read(`${docs}tools/${slug}.mdx`)).toContain(tool.name);
  }
});

test("capabilities matrix arguments match the source input schemas", () => {
  const matrix = read(docs + "tools/capabilities.mdx");
  for (const tool of publicTools) {
    const row = matrix.split("\n").find((line) => line.startsWith(`| \`${tool.name}\` |`));
    expect(row, tool.name).toBeDefined();
    const args = [...row!.split("|")[3].matchAll(/`([a-zA-Z0-9_]+)`/g)].map((match) => match[1]).sort();
    expect(args, tool.name).toEqual(Object.keys(tool.inputSchema.properties).sort());
  }
});

test("command inventory matches shipped command files exactly", () => {
  const commands = readdirSync(join(root, "commands")).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
  const index = read(docs + "skills/index.mdx");
  const listed = [...index.matchAll(/^\| \[`\/([a-z0-9-]+)`\]/gm)].map((match) => match[1]).sort();
  expect(listed).toEqual(commands);
  expect(index).toContain(`**${commands.length} slash commands**`);
  for (const command of commands) {
    expect(read(`commands/${command}.md`)).toContain(`name: ${command}`);
    expect(read(`${docs}skills/${command.replace(/^ashlr-/, "")}.mdx`)).toContain(`/${command}`);
  }
});

test("headline counts match the shipped public tools and commands", () => {
  const count = readdirSync(join(root, "commands")).filter((name) => name.endsWith(".md")).length;
  for (const path of ["README.md", docs + "index.mdx", docs + "getting-started/index.mdx", docs + "pro/index.mdx", docs + "pro/pricing.mdx"]) {
    const source = read(path);
    expect(source).toContain(`${count} slash commands`);
    for (const match of source.matchAll(/(\d+) MCP tools/g)) expect(Number(match[1])).toBe(publicTools.length);
    for (const match of source.matchAll(/(\d+) slash commands/g)) expect(Number(match[1])).toBe(count);
  }
});

test("refreshed tool parameter tables and JSON examples use registered arguments", () => {
  for (const slug of ["task-get", "notebook-edit", "websearch", "webfetch", "write", "edit-structural", "search-replace-regex"]) {
    const tool = catalog.find((entry) => entry.name === `ashlr__${slug.replaceAll("-", "_")}`)!;
    const source = read(`${docs}tools/${slug}.mdx`);
    const parameters = [...source.matchAll(/^\| `([a-zA-Z0-9_]+)` \| (?:string|number|array|boolean) \| (yes|no) \|/gm)];
    expect(parameters.map((match) => match[1]).sort(), slug).toEqual(Object.keys(tool.inputSchema.properties).sort());
    expect(parameters.filter((match) => match[2] === "yes").map((match) => match[1]).sort(), slug).toEqual([...(tool.inputSchema.required ?? [])].sort());
    for (const match of source.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const example = JSON.parse(match[1]) as { tool: string; arguments: Record<string, unknown> };
      expect(example.tool).toBe(tool.name);
      for (const key of Object.keys(example.arguments)) expect(Object.keys(tool.inputSchema.properties), slug).toContain(key);
      for (const key of tool.inputSchema.required ?? []) expect(example.arguments, slug).toHaveProperty(key);
    }
  }
});
