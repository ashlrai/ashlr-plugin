#!/usr/bin/env bun
/**
 * gen-docs.ts — build-time doc generator for the ashlr reference site.
 *
 * 1. Reads .claude-plugin/plugin.json to enumerate MCP servers.
 * 2. For each server, reads servers/<name>-server.ts and extracts the JSDoc
 *    top-of-file comment and tool names. Writes tools/ pages only if the page
 *    does not already exist (hand-written pages are never overwritten).
 * 3. Reads commands/*.md for skill frontmatter + body. Writes skills/ pages
 *    only if the page does not already exist.
 * 4. Skips silently on any extraction failure — never crashes the build.
 *
 * Run via: bun run scripts/gen-docs.ts
 * Or as a pre-build hook in package.json: "prebuild": "bun run scripts/gen-docs.ts"
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Portable across Bun (import.meta.dir) and Node (no .dir extension on ImportMeta)
const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = resolve(SITE_ROOT, "..");
const PLUGIN_JSON = join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
const SERVERS_DIR = join(PLUGIN_ROOT, "servers");
const COMMANDS_DIR = join(PLUGIN_ROOT, "commands");
const TOOLS_OUT = join(SITE_ROOT, "content", "docs", "tools");
const SKILLS_OUT = join(SITE_ROOT, "content", "docs", "skills");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function extractJsdocComment(source: string): string {
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "";
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function extractToolNames(source: string): string[] {
  const names: string[] = [];
  // Match: name: "ashlr__something"
  const re = /name:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1].startsWith("ashlr__")) names.push(m[1]);
  }
  return [...new Set(names)];
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

function writeIfMissing(path: string, content: string, label: string): "written" | "skipped" {
  if (existsSync(path)) {
    console.log(`  skip  ${label} (hand-written page exists)`);
    return "skipped";
  }
  writeFileSync(path, content, "utf-8");
  console.log(`  gen   ${label}`);
  return "written";
}

// ---------------------------------------------------------------------------
// Tool page generation
// ---------------------------------------------------------------------------

function generateToolPage(serverName: string, serverFile: string): { written: number; skipped: number; failed: number } {
  let written = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const source = safeRead(serverFile);
    if (!source) {
      console.warn(`  warn  ${serverName}: server file not found`);
      failed++;
      return { written, skipped, failed };
    }

    const jsdoc = extractJsdocComment(source);
    const toolNames = extractToolNames(source);

    if (toolNames.length === 0) {
      console.warn(`  warn  ${serverName}: no tool names found`);
      failed++;
      return { written, skipped, failed };
    }

    // Extract first line of jsdoc as description
    const descriptionLine = jsdoc.split("\n").find((l) => l.trim().length > 0) ?? `${serverName} MCP server.`;

    for (const toolName of toolNames) {
      const slug = slugify(toolName.replace("ashlr__", "").replace(/_/g, "-"));
      const outPath = join(TOOLS_OUT, `${slug}.mdx`);

      const content = `---
title: ${toolName}
description: ${descriptionLine}
---

**Server:** \`${serverName}\` — \`servers/${basename(serverFile)}\`

${jsdoc}

## Tool names

${toolNames.map((t) => `- \`${t}\``).join("\n")}

> This page was auto-generated from the server source. See the [GitHub source](https://github.com/ashlrai/ashlr-plugin/blob/main/servers/${basename(serverFile)}) for the full implementation.
`;

      const result = writeIfMissing(outPath, content, `tools/${slug}.mdx`);
      if (result === "written") written++;
      else skipped++;
    }
  } catch (err) {
    console.warn(`  error ${serverName}:`, err instanceof Error ? err.message : String(err));
    failed++;
  }

  return { written, skipped, failed };
}

// ---------------------------------------------------------------------------
// Skill page generation
// ---------------------------------------------------------------------------

function generateSkillPage(commandFile: string): { written: number; skipped: number; failed: number } {
  let written = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const source = safeRead(commandFile);
    if (!source) {
      console.warn(`  warn  ${commandFile}: file not found`);
      failed++;
      return { written, skipped, failed };
    }

    // Parse frontmatter
    const fmMatch = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) {
      console.warn(`  warn  ${commandFile}: no frontmatter`);
      failed++;
      return { written, skipped, failed };
    }

    const fm = fmMatch[1];
    const body = fmMatch[2].trim();

    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);

    const name = nameMatch?.[1]?.trim() ?? basename(commandFile, ".md");
    const description = descMatch?.[1]?.trim() ?? `${name} skill.`;

    // skill slug: strip "ashlr-" prefix
    const slug = name.replace(/^ashlr-/, "");
    const outPath = join(SKILLS_OUT, `${slug}.mdx`);

    const content = `---
title: /${name}
description: ${description}
---

${body}
`;

    const result = writeIfMissing(outPath, content, `skills/${slug}.mdx`);
    if (result === "written") written++;
    else skipped++;
  } catch (err) {
    console.warn(`  error ${commandFile}:`, err instanceof Error ? err.message : String(err));
    failed++;
  }

  return { written, skipped, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("gen-docs: generating reference pages...\n");

  mkdirSync(TOOLS_OUT, { recursive: true });
  mkdirSync(SKILLS_OUT, { recursive: true });

  let totalWritten = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  // --- Tools from plugin.json ---
  console.log("Tools (from .claude-plugin/plugin.json + server files):");

  const pluginJson = safeRead(PLUGIN_JSON);
  if (!pluginJson) {
    console.warn("  warn: plugin.json not found — skipping tool generation");
  } else {
    try {
      const plugin = JSON.parse(pluginJson);
      const servers = plugin.mcpServers ?? {};

      for (const [serverName, config] of Object.entries(servers)) {
        // Extract the server file name from the args array
        const args = (config as { args?: string[] }).args ?? [];
        const serverFileArg = args.find((a: string) => a.endsWith("-server.ts"));
        if (!serverFileArg) continue;

        const serverFile = join(PLUGIN_ROOT, serverFileArg);
        const result = generateToolPage(serverName, serverFile);
        totalWritten += result.written;
        totalSkipped += result.skipped;
        totalFailed += result.failed;
      }
    } catch (err) {
      console.warn("  error parsing plugin.json:", err instanceof Error ? err.message : String(err));
    }
  }

  // --- Skills from commands/*.md ---
  console.log("\nSkills (from commands/*.md):");

  try {
    const { readdirSync } = await import("fs");
    const commandFiles = readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(COMMANDS_DIR, f));

    for (const commandFile of commandFiles) {
      const result = generateSkillPage(commandFile);
      totalWritten += result.written;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
    }
  } catch (err) {
    console.warn("  error reading commands dir:", err instanceof Error ? err.message : String(err));
  }

  console.log(`
gen-docs complete:
  written:  ${totalWritten}
  skipped:  ${totalSkipped} (hand-written pages preserved)
  failed:   ${totalFailed}
`);

  if (totalFailed > 0) {
    // Don't exit 1 — never crash the build
    console.warn("Some pages failed to generate (see warnings above). Build continues.");
  }
}

main().catch((err) => {
  console.error("gen-docs fatal:", err);
  // Don't exit 1 — never crash the build
});
