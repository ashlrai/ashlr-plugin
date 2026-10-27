export interface ProductTextData {
  version: string;
  release: { version: string; date: string; notes: string };
  install: { bootstrap: string; claude: string; codex: string; cursor: string; goose: string; npm: string };
  tools: { name: string; description: string; enableEnv?: string }[];
  commands: { name: string; description: string }[];
  workflowSkills?: { name: string; description: string }[];
  counts: { mcpTools: number; slashCommands: number };
}

export interface DocumentationTextData {
  title: string;
  url: string;
  description: string;
  content: string;
}

/** Shared product facts keep the short and full AI endpoints in sync. */
export function productText(product: ProductTextData): string {
  const lines = [
    `## Current release: v${product.version}`,
    "",
    `Latest release: v${product.release.version} (${product.release.date}).`,
    product.release.notes,
    "",
    "## Install",
    "",
  ];
  const installs = [
    ["npm CLI and MCP entrypoints", product.install.npm],
    ["Claude Code", product.install.claude],
    ["Codex", product.install.codex],
    ["Cursor", product.install.cursor],
    ["Goose", product.install.goose],
  ];
  for (const [host, command] of installs) {
    lines.push(`### ${host}`, "", "```sh", command, "```", "");
  }
  lines.push(`## MCP tools (${product.counts.mcpTools} enabled by default)`, "");
  for (const tool of product.tools) {
    const condition = tool.enableEnv ? ` [requires ${tool.enableEnv}=1]` : "";
    lines.push(`- \`${tool.name}\`${condition}: ${tool.description}`);
  }
  lines.push("", `## Slash commands (${product.counts.slashCommands})`, "");
  for (const command of product.commands) {
    const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
    lines.push(`- \`${name}\`: ${command.description}`);
  }
  if (product.workflowSkills?.length) {
    lines.push("", `## Workflow skills (${product.workflowSkills.length})`, "");
    for (const skill of product.workflowSkills) lines.push(`- \`${skill.name}\`: ${skill.description}`);
  }
  return lines.join("\n");
}

/** Preserve code fences and placeholders while removing MDX-only markup. */
export function plainDocumentation(content: string): string {
  return content.split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$)/gm).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      .replace(/^(?:import|export)\s.+$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/<\/?[A-Z][A-Za-z]*(?:\s[^>]*?)?\s*\/?>/g, "");
  }).join("").trim();
}

export function documentationText(pages: DocumentationTextData[], base: string): string {
  return pages.map((page) => [
    `# ${page.title}`,
    `URL: ${base}${page.url}`,
    page.description ? `> ${page.description}` : "",
    "",
    plainDocumentation(page.content),
    "",
    "---",
  ].join("\n")).join("\n\n");
}
