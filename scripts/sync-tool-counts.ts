#!/usr/bin/env bun
// Maintained product copy only: historical releases and usage examples are not current claims.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const countFiles = [
  ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json",
  "CONTRIBUTING.md", "README.md", "docs/architecture.md", "docs/billing.md",
  "docs/competitive-wozcode.md", "docs/index.html", "docs/launch-post.md",
  "docs/launch/hn.md", "docs/launch/reddit.md", "docs/launch/x.md",
  "docs/multi-host-mcp.md", "docs/press-kit/fact-sheet.md", "docs/pricing.md",
  "docs/producthunt.md", "docs/social.md", "examples/mcp-client/README.md",
  "ports/README.md", "ports/goose/recipe.yaml", "scripts/smoke-tools.ts",
  "site/content/docs/contributing/architecture.mdx", "site/content/docs/getting-started/index.mdx",
  "site/content/docs/index.mdx", "site/content/docs/pro/index.mdx", "site/content/docs/pro/pricing.mdx",
  "site/content/docs/tools/capabilities.mdx", "site/content/docs/tools/index.mdx",
  "site/content/docs/tools/pipe.mdx", "site/lib/docs.generated.json", "site/lib/product.generated.json",
  "video/src/compositions/BrowserFrame.tsx",
];

export function syncToolCounts(root: string, check: boolean): { count: number; changed: string[] } {
  const catalog: unknown = JSON.parse(readFileSync(resolve(root, "servers/_tool-catalog.json"), "utf8"));
  if (!Array.isArray(catalog) || !catalog.length || catalog.some((tool) =>
    !tool || typeof tool.name !== "string" || (tool.enableEnv !== undefined && typeof tool.enableEnv !== "string")
  ) || new Set(catalog.map((tool) => tool.name)).size !== catalog.length) {
    throw new Error("Invalid tool catalog");
  }
  const count = catalog.filter((tool) => !tool.enableEnv).length;
  if (!count) throw new Error("Tool catalog has no default tools");
  const changed: string[] = [];
  const updates: Array<{ path: string; text: string }> = [];
  for (const file of countFiles) {
    const path = resolve(root, file);
    const before = readFileSync(path, "utf8");
    let matches = 0;
    const replace = (pattern: RegExp, numberGroup: "first" | "last" = "first") => {
      after = after.replace(pattern, (_match, a: string, b: string) => {
        matches++;
        return numberGroup === "first" ? `${count}${b}` : `${a}${count}`;
      });
    };
    let after = before;
    replace(/\b(\d+)( (?:token-efficient |default )?MCP tools\b)/g);
    replace(/(\b(?:all |exposes |exposes \*\*|server: |with all ))(\d+)(?= (?:default )?tools\b)/gi, "last");
    if (file === "docs/social.md") replace(/\b(\d+)( tools\. Reproducible)/g);
    replace(/(\bMCP tools \()(\d+)(?=\)| total\))/g, "last");
    replace(/("mcpTools":\s*)(\d+)/g, "last");
    replace(/(EXPECTED_TOOL_COUNT = )(\d+)/g, "last");
    if (!matches) throw new Error(`No tool count found in ${file}`);
    if (before !== after) {
      changed.push(file);
      updates.push({ path, text: after });
    }
  }
  if (!check) for (const update of updates) writeFileSync(update.path, update.text);
  return { count, changed };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check")) throw new Error("Usage: bun run scripts/sync-tool-counts.ts [--check]");
    const check = args.includes("--check");
    const result = syncToolCounts(ROOT, check);
    console.log(`Default MCP tools: ${result.count}; ${result.changed.length} file(s) ${check ? "out of sync" : "updated"}`);
    for (const file of result.changed) console.log(file);
    if (check && result.changed.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
