import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { declaredToolNames } from "../scripts/gen-tool-catalog";
import catalog from "../servers/_tool-catalog.json";
import { generatedFiles } from "../site/scripts/freshness";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const docs = "site/content/docs/";
const publicTools = catalog.filter((tool) => !("enableEnv" in tool));
const toolNames = catalog.map((tool) => tool.name).sort();
const commandFiles = readdirSync(join(root, "commands")).filter((name) => name.endsWith(".md")).sort();
const commands = commandFiles.map((name) => name.slice(0, -3)).sort();
const ashlrNames = (text: string) => [...new Set(text.match(/ashlr__[a-z0-9_]+/g))].sort();

test("documented tool inventories match handler declarations and catalog", () => {
  const imports = [...read("servers/_router-handlers.ts").matchAll(/^import "\.\/([a-z0-9-]+-server-handlers)";/gm)];
  expect(imports.length).toBeGreaterThan(0);
  const declared = imports.flatMap((match) => declaredToolNames(read(`servers/${match[1]}.ts`))).sort();
  expect(declared).toEqual(toolNames);
  for (const page of ["tools/index.mdx", "tools/capabilities.mdx"]) {
    expect(ashlrNames(read(docs + page))).toEqual(toolNames);
  }
  for (const tool of catalog) {
    const slug = tool.name.replace("ashlr__", "").replaceAll("_", "-");
    expect(read(`${docs}tools/${slug}.mdx`)).toContain(tool.name);
  }
});

test("capabilities matrix rows carry the catalog parameters and activation state", () => {
  const matrix = read(docs + "tools/capabilities.mdx");
  for (const tool of catalog) {
    const row = matrix.split("\n").find((line) => line.startsWith(`| \`${tool.name}\` |`));
    expect(row, tool.name).toBeDefined();
    const cells = row!.split("|").map((cell) => cell.trim());
    const params = [...cells[2].matchAll(/`([a-zA-Z0-9_]+)`(\*?)/g)];
    expect(params.map((match) => match[1]).sort(), tool.name).toEqual(Object.keys(tool.inputSchema.properties ?? {}).sort());
    const required = params.filter((match) => match[2] === "*").map((match) => match[1]).sort();
    expect(required, tool.name).toEqual([...(tool.inputSchema.required ?? [])].sort());
    expect(cells[3], tool.name).toBe("enableEnv" in tool ? `\`${tool.enableEnv}=1\`` : "Default");
  }
});

test("command inventory matches shipped command files exactly", () => {
  const index = read(docs + "skills/index.mdx");
  const listed = [...index.matchAll(/^### \/([a-z0-9-]+)$/gm)].map((match) => match[1]).sort();
  expect(listed).toEqual(commands);
  expect(index).toContain(`**${commands.length} slash commands**`);
  const meta = JSON.parse(read(docs + "skills/meta.json")) as { pages: string[] };
  const reference = read("docs/commands.md");
  for (const command of commands) {
    expect(read(`commands/${command}.md`)).toContain(`name: ${command}`);
    const slug = command.replace(/^ashlr-/, "");
    expect(existsSync(join(root, docs, "skills", `${slug}.mdx`)), command).toBe(true);
    expect(meta.pages, command).toContain(slug);
    expect(reference, command).toContain(`[\`/${command}\`]`);
  }
});

test("headline counts match the shipped public tools and commands", () => {
  for (const path of ["README.md", docs + "index.mdx", docs + "getting-started/index.mdx", docs + "pro/index.mdx", docs + "pro/pricing.mdx", docs + "skills/index.mdx", docs + "skills/help.mdx"]) {
    const source = read(path);
    for (const match of source.matchAll(/(\d+) MCP tools/g)) expect(Number(match[1]), `${path}: ${match[0]}`).toBe(publicTools.length);
    for (const match of source.matchAll(/(\d+) slash commands/g)) expect(Number(match[1]), `${path}: ${match[0]}`).toBe(commands.length);
  }
});

test("authored tool parameter tables and JSON examples use registered arguments", () => {
  const documented = [
    "edit-structural", "issue-close", "issue-create", "notebook-edit", "pipe",
    "pr-approve", "pr-comment", "rename-file", "search-replace-regex", "task-get",
    "task-list", "test", "webfetch", "websearch", "write",
  ];
  for (const slug of documented) {
    const tool = catalog.find((entry) => entry.name === `ashlr__${slug.replaceAll("-", "_")}`)!;
    const source = read(`${docs}tools/${slug}.mdx`);
    const rows = [...source.matchAll(/^\| `([a-zA-Z0-9_]+)` \| (.+?) \| (yes|no) \|/gm)];
    expect(rows.map((match) => match[1]).sort(), slug).toEqual(Object.keys(tool.inputSchema.properties ?? {}).sort());
    expect(rows.filter((match) => match[3] === "yes").map((match) => match[1]).sort(), slug)
      .toEqual([...(tool.inputSchema.required ?? [])].sort());
    for (const match of source.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const example = JSON.parse(match[1]) as { tool?: string; arguments?: Record<string, unknown> };
      if (!example.arguments) continue;
      expect(example.tool, slug).toBe(tool.name);
      for (const key of Object.keys(example.arguments)) expect(Object.keys(tool.inputSchema.properties), slug).toContain(key);
      for (const key of tool.inputSchema.required ?? []) expect(example.arguments, slug).toHaveProperty(key);
    }
  }
});

test("internal /docs/skills links resolve to existing pages", () => {
  const valid = new Set(readdirSync(join(root, docs, "skills")).filter((name) => name.endsWith(".mdx")).map((name) => name.slice(0, -4)));
  for (const entry of readdirSync(join(root, docs), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mdx")) continue;
    const path = join(entry.parentPath, entry.name);
    for (const match of readFileSync(path, "utf8").matchAll(/\]\(\/docs\/skills\/([a-z0-9-]+)/g)) {
      expect(valid, `${path.slice(root.length + 1)} -> ${match[0]}`).toContain(match[1]);
    }
  }
});

test("generated site docs are fresh against the source of truth", () => {
  const stale: string[] = [];
  for (const [path, generated] of generatedFiles(root)) {
    const current = existsSync(join(root, path)) ? read(path) : "";
    if (current !== generated) stale.push(path);
  }
  expect(stale).toEqual([]);
});
