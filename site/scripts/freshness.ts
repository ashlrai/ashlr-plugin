import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clean = (text: string) => text.replace(/\u2014/g, ";");
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

export function section(text: string, heading: string, level = 2): string {
  const prefix = "#".repeat(level);
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `${prefix} ${heading}`);
  if (start < 0) throw new Error(`Missing source section: ${heading}`);
  let fenced = false;
  const end = lines.findIndex((line, i) => {
    if (i <= start) return false;
    if (/^\s*```/.test(line)) fenced = !fenced;
    return !fenced && new RegExp(`^#{1,${level}} `).test(line);
  });
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function blocks(text: string): string[] {
  return [...text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)]
    .map((match) => match[1].split("\n").map((line) => line.trimStart()).filter((line) => !line.startsWith("#")).join("\n").trim());
}

/** Reads a frontmatter scalar, unfolding YAML block scalars (`>`, `|`). */
export function frontmatterField(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \t]*(.*)$`, "m").exec(frontmatter);
  if (!match) return undefined;
  const inline = match[1].trim();
  if (inline !== ">" && inline !== "|") return inline || undefined;
  const parts: string[] = [];
  for (const line of frontmatter.slice(match.index + match[0].length).split("\n")) {
    if (line.trim() && !/^\s/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(inline === ">" ? " " : "\n").trim() || undefined;
}

export function buildProduct(root = ROOT) {
  const pkg = JSON.parse(read(root, "package.json")) as { version: string; name: string; bin: Record<string, string> };
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error("Invalid package version");
  const changelog = read(root, "CHANGELOG.md");
  const release = /^## \[(\d+\.\d+\.\d+[^\]]*)\]\s+[-\u2014]\s+(\d{4}-\d{2}-\d{2})\s*$/m.exec(changelog);
  if (!release) throw new Error("CHANGELOG.md has no dated release");
  const notes = changelog.slice(release.index + release[0].length).split(/^## /m)[0].trim();
  const installBlocks = blocks(section(read(root, "README.md"), "Install"));
  const bootstrap = installBlocks.find((block) => block.startsWith("curl "));
  const codex = installBlocks.find((block) => block.includes("codex plugin marketplace add"));
  const claude = installBlocks.find((block) => block.startsWith("/plugin marketplace add"));
  if (!bootstrap || !codex || !claude) throw new Error("README Install must document bootstrap, Codex and Claude commands");
  const ports = read(root, "ports/README.md");
  const checkout = blocks(section(ports, "Install"))[0];
  const cursor = blocks(section(ports, "Cursor"))[0];
  const goose = blocks(section(ports, "Goose"))[0];
  if (!checkout || !cursor || !goose) throw new Error("Missing portable host install commands");
  const cli = read(root, "scripts/cli.ts");
  const npm = cli.match(/npm install -g [a-z0-9@/._-]+/)?.[0];
  if (!npm || !npm.endsWith(pkg.name) || !pkg.bin[pkg.name]) throw new Error("CLI package install hint does not match package bin");
  const tools = (JSON.parse(read(root, "servers/_tool-catalog.json")) as Array<{ name: string; description: string; enableEnv?: string }>)
    .map(({ name, description, enableEnv }) => {
      if (!/^ashlr__[a-z0-9_]+$/.test(name) || !description) throw new Error("Invalid MCP catalog entry");
      return { name, description: clean(description), ...(enableEnv ? { enableEnv } : {}) };
    });
  if (!tools.length || new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Empty or duplicate MCP catalog");
  const commands = readdirSync(join(root, "commands")).filter((file) => file.endsWith(".md")).sort().map((file) => {
    const source = read(root, `commands/${file}`);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
    const name = frontmatterField(frontmatter, "name");
    const description = frontmatterField(frontmatter, "description");
    if (!name || !description || `${name}.md` !== file) throw new Error(`Invalid command frontmatter: ${file}`);
    return { name, description: clean(description.replace(/^(["'])(.*)\1$/, "$2")) };
  });
  const workflowSkills = readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^ashlr-/.test(entry.name))
    .map((entry) => entry.name).sort().map((directory) => {
      const path = `skills/${directory}/SKILL.md`;
      const source = read(root, path);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
      const name = frontmatterField(frontmatter, "name");
      const description = frontmatterField(frontmatter, "description");
      if (!name || !description || name !== directory) throw new Error(`Invalid workflow skill frontmatter: ${path}`);
      return { name, description: clean(description.replace(/^(["'])(.*)\1$/, "$2")) };
    });
  return {
    version: pkg.version,
    release: { version: release[1], date: release[2], notes: clean(notes) },
    install: { bootstrap, claude: `${bootstrap}\n${claude}`, codex, cursor: `${checkout}\n${cursor}`, goose: `${checkout}\n${goose}`, npm },
    tools,
    commands,
    workflowSkills,
    counts: { mcpTools: tools.filter((tool) => !tool.enableEnv).length, slashCommands: commands.length },
  };
}

export type Product = ReturnType<typeof buildProduct>;
const json = (value: unknown) => `${clean(JSON.stringify(value, null, 2))}\n`;
const frontmatter = (title: string, description: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
const fence = (text: string) => `\n\`\`\`sh\n${text}\n\`\`\`\n`;
// Descriptions are Markdown text, not executable MDX. Keep inline code intact
// while escaping JSX/expression delimiters in prose from the tool registry.
export const prose = (text: string) => text.split(/(`[^`]*`)/g).map((part, index) => index % 2 ? part :
  part.replace(/[<>{}]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;" })[char]!)).join("");

/** Refresh factual literals in authored MDX while retaining the surrounding explanation. */
export function refreshDoc(source: string, product: Product): string {
  return source
    .replace(/```(?:sh|bash)\n([\s\S]*?)\n```/g, (block, command: string) => {
      if (command.startsWith("git clone ") && command.includes("codex plugin marketplace add")) return fence(product.install.codex).trim();
      if (command.startsWith("curl ") && command.includes("plugin.ashlr.ai/install.sh")) return fence(product.install.bootstrap).trim();
      return block;
    })
    .replace(/\b\d+ MCP tools\b/g, `${product.counts.mcpTools} MCP tools`)
    .replace(/\b\d+ slash commands\b/g, `${product.counts.slashCommands} slash commands`)
    .replace(/\b\d+ ashlr-prefixed slash commands\b/g, `${product.counts.slashCommands} ashlr-prefixed slash commands`)
    .replace(/MCP tools \(\d+\)/g, `MCP tools (${product.counts.mcpTools})`)
    .replace(/all \d+ tools/g, `all ${product.counts.mcpTools} tools`)
    .replace(/(ashlr(?:-plugin)?\s+v?)\d+\.\d+\.\d+/g, `$1${product.version}`)
    .replace(/(Version:\s+)\d+\.\d+\.\d+/g, `$1${product.version}`)
    .replace(/(plugin version[^\n]*|ashlr\s+)\d+\.\d+\.\d+/g, `$1${product.version}`)
    .replace(/(activate v|up to date \(v)\d+\.\d+\.\d+/g, `$1${product.version}`)
    .replace(/Updating ashlr from [\d.]+ to [\d.]+/g, `Updating ashlr to ${product.version}`)
    .replace(/\[\d+ tools\]/g, `[${product.counts.mcpTools} tools]`)
    .replace(/```sh\ncurl -fsSL https:\/\/plugin\.ashlr\.ai\/install\.sh \| bash\n```/g, fence(product.install.bootstrap).trim());
}

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)]);
}

/** Reject copied facts in executable pages, including copies that happen to be current. */
export function consumerErrors(path: string, source: string): string[] {
  const errors: string[] = [];
  const patterns = [
    /\bv\d+\.\d+\.\d+\b/,
    /(?:>|["'`])\s*\d+\.\d+\.\d+(?:\s*<|["'`])/,
    /\bv?\d+\.\d+\.\d+\s+is current\b/,
    /(?:[Cc]urrent (?:version|release):?\s*v?|[Vv]ersion:\s*v?|ashlr(?:-plugin)?\s+v?)\d+\.\d+\.\d+/,
    /softwareVersion:\s*["'](?:latest|\d)/,
    /\b\d+(?:-tool| MCP tools| slash commands)/,
    /MCP tools \(\d+ total\)/,
    /curl -fsSL https:\/\/plugin\.ashlr\.ai\/install\.sh/,
    /(?:codex )?plugin marketplace add ashlrai\/ashlr-plugin/,
    /(?:<code[^>]*>|["'`])\/?(?:codex )?plugin (?:marketplace add|install|add)\s/,
    /(?:npm (?:install|i) -g|npx) ashlr-plugin/,
    /git clone https:\/\/github\.com\/ashlrai\/ashlr-plugin/,
    /(?:<code[^>]*>|["'`])ashlr-plugin\s+[a-z][a-z-]+/,
    /["']cmd["']?:\s*["'`]/,
  ];
  for (const pattern of patterns) if (pattern.test(source)) errors.push(`${path}: copied product fact (${pattern.source}); use product.generated.json`);
  return errors;
}

export function generatedFiles(root = ROOT): Map<string, string> {
  const product = buildProduct(root);
  const out = new Map<string, string>([["site/lib/product.generated.json", json(product)]]);
  const commandRows = product.commands.map((command) => `### /${command.name}\n\n${prose(command.description)}\n`).join("\n");
  out.set("site/content/docs/skills/help.mdx", frontmatter("/ashlr-help", "Current command reference, generated from shipped command frontmatter.") +
    `{/* Generated by site/scripts/gen-docs.ts from commands/*.md. */}\n\nThe plugin ships **${product.counts.slashCommands} slash commands**. Run \`/ashlr-help\` in Claude Code or browse the current command reference below.\n\n${commandRows}`);
  const toolRows = product.tools.map((tool) => `### ${tool.name}\n\n${prose(tool.description)}${tool.enableEnv ? `\n\nRequires \`${tool.enableEnv}=1\` (experimental, excluded from the default count).` : ""}\n`);
  out.set("site/content/docs/tools/index.mdx", frontmatter("MCP tools", `${product.counts.mcpTools} default MCP tools, derived from the router catalog.`) +
    `{/* Generated by site/scripts/gen-docs.ts. Edit the registry, then run bun run gen-docs in site/. */}\n\nThe default router exposes **${product.counts.mcpTools} MCP tools**. Flag-gated tools are listed separately below with their activation condition. Descriptions come from the same catalog used by MCP tools/list.\n\n${toolRows.join("\n")}\nSee [savings methodology](/docs/concepts/savings-math) and the [capabilities matrix](/docs/tools/capabilities).\n`);
  out.set("site/content/docs/skills/index.mdx", frontmatter("Commands and workflow skills", `${product.counts.slashCommands} shipped slash commands and ${product.workflowSkills.length} workflow skills, derived from repository frontmatter.`) +
    `{/* Generated by site/scripts/gen-docs.ts. Edit command frontmatter or workflow SKILL.md files. */}\n\nClaude Code ships **${product.counts.slashCommands} slash commands**. The plugin also ships **${product.workflowSkills.length} workflow skills** for supported hosts.\n\n## Slash commands\n\n` +
    commandRows +
    "\n## Workflow skills\n\n" + product.workflowSkills.map((skill) => `### ${skill.name}\n\n${prose(skill.description)}\n`).join("\n"));
  const skillSlugs = [...new Set([...product.commands, ...product.workflowSkills]
    .map((surface) => surface.name.replace(/^ashlr-/, "")))].sort();
  out.set("site/content/docs/skills/meta.json", json({ title: "Commands and workflow skills", pages: ["index", ...skillSlugs] }));
  const catalog = JSON.parse(read(root, "servers/_tool-catalog.json")) as Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] }; enableEnv?: string }>;
  const cell = (text: string) => prose(text).replace(/\|/g, "&#124;").replace(/\n/g, " ");
  out.set("site/content/docs/tools/capabilities.mdx", frontmatter("Capabilities matrix", "MCP tool names, parameters and activation conditions from the router catalog.") +
    `{/* Generated from servers/_tool-catalog.json. */}\n\nThe default router exposes **${product.counts.mcpTools} tools**. Optional tools are excluded from this count. Parameter names marked with * are required. See the [tool catalog](/docs/tools) for descriptions.\n\n| Tool | Parameters | Availability |\n| --- | --- | --- |\n` + catalog.map((tool) => {
      const parameters = Object.keys(tool.inputSchema.properties ?? {}).map((key) => `\`${cell(key)}\`${tool.inputSchema.required?.includes(key) ? "*" : ""}`).join(", ") || "None";
      return `| \`${tool.name}\` | ${parameters} | ${tool.enableEnv ? `\`${tool.enableEnv}=1\`` : "Default"} |`;
    }).join("\n") + "\n");
  out.set("site/content/docs/getting-started/install.mdx", frontmatter("Install", "Install Ashlr in Claude Code, Codex, Cursor or Goose using the repository instructions.") +
    `{/* Generated by site/scripts/gen-docs.ts from README.md, ports/README.md and the CLI install hint. */}\n\n## npm CLI and MCP entrypoints\n\nWith [Bun](https://bun.sh/) installed:\n${fence(product.install.npm)}\nThe package exposes \`ashlr-plugin\` and \`ashlr-mcp\`. Installing it does not register a host or approve its tools.\n\n## Claude Code\n${fence(product.install.claude)}\nRun \`/ashlr-status\` to verify. If the plugin is not visible, fully quit and restart Claude Code. Use \`/ashlr-doctor\` for diagnostics.\n\n## Codex\n${fence(product.install.codex)}\nThe checkout includes \`.codex-plugin/plugin.json\`, \`.mcp.json\`, workflow skills, and nudge-first hooks.\n\n## Cursor\n\nBack up or merge any existing MCP config before applying the repository example. Replace the example clone path with your absolute path.\n${fence(product.install.cursor)}\nRestart Cursor after saving.\n\n## Goose\n\nReplace the example clone path with your absolute path.\n${fence(product.install.goose)}\n## Requirements\n\nBun and a supported host. See the [source install guide](https://github.com/ashlrai/ashlr-plugin#install) for prerequisites and manual setup.\n`);
  out.set("site/content/docs/release.mdx", frontmatter("Latest release", `Latest released version ${product.release.version}, dated ${product.release.date}.`) +
    `{/* Generated from package.json and the latest dated CHANGELOG.md section, excluding Unreleased. */}\n\nCurrent package version: **${product.version}**.\n\n## Released ${product.release.version} (${product.release.date})\n\n${product.release.notes}\n`);
  // Only new command pages need scaffolding. Existing authored guides stay intact.
  for (const command of product.commands) {
    const path = `site/content/docs/skills/${command.name.replace(/^ashlr-/, "")}.mdx`;
    if (!existsSync(join(root, path))) out.set(path, frontmatter(`/${command.name}`, command.description) + `Run \`/${command.name}\` in Claude Code.\n\n${prose(command.description)}\n`);
  }
  for (const skill of product.workflowSkills) {
    const path = `site/content/docs/skills/${skill.name.replace(/^ashlr-/, "")}.mdx`;
    if (!existsSync(join(root, path)) && !out.has(path)) {
      out.set(path, frontmatter(skill.name, skill.description) +
        `This workflow is shipped in \`skills/${skill.name}/SKILL.md\`.\n\n${prose(skill.description)}\n`);
    }
  }
  const docs = new Map(filesUnder(join(root, "site/content/docs")).filter((path) => path.endsWith(".mdx")).map((path) => [relative(root, path), readFileSync(path, "utf8")]));
  for (const [path, source] of docs) {
    if (out.has(path)) continue;
    const refreshed = refreshDoc(source, product);
    if (refreshed !== source) out.set(path, refreshed);
    docs.set(path, refreshed);
  }
  for (const [path, source] of out) if (path.endsWith(".mdx")) docs.set(path, source);
  const corpus = [...docs].sort(([a], [b]) => a.localeCompare(b)).map(([path, source]) => {
    const fm = /^---\n([\s\S]*?)\n---\n*/.exec(source);
    const field = (key: string) => {
      const value = fm?.[1].match(new RegExp(`^${key}: (.+)$`, "m"))?.[1] ?? "";
      return value.startsWith('"') ? JSON.parse(value) as string : value;
    };
    const slug = path.replace("site/content/docs/", "").replace(/(?:\/)?index\.mdx$|\.mdx$/g, "");
    return { title: field("title"), description: field("description"), url: `/docs${slug ? `/${slug}` : ""}`, content: source.slice(fm?.[0].length ?? 0).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim() };
  });
  out.set("site/lib/docs.generated.json", json(corpus));
  return out;
}

export function syncSite(check = false, root = ROOT): void {
  const errors: string[] = [];
  for (const dir of ["site/app", "site/components", "site/lib"]) {
    for (const path of filesUnder(join(root, dir)).filter((path) => /\.[cm]?[jt]sx?$/.test(path))) errors.push(...consumerErrors(relative(root, path), readFileSync(path, "utf8")));
  }
  for (const [path, generated] of generatedFiles(root)) {
    const current = existsSync(join(root, path)) ? read(root, path) : "";
    if (current === generated) continue;
    if (check) errors.push(`${path} is stale; run (cd site && bun run gen-docs)`);
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), generated);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
