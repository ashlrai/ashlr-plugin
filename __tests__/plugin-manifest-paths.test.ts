import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

function loadPluginManifest(): Record<string, unknown> | null {
  const raw = readFileSync(
    resolve(REPO_ROOT, ".claude-plugin", "plugin.json"),
    "utf8",
  );
  const obj = JSON.parse(raw);
  return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null;
}

function collectFilePaths(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const paths: string[] = [];
  for (const entry of args) {
    if (typeof entry !== "string") continue;
    const resolved = entry.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//, "");
    if (resolved.includes("/") || resolved.endsWith(".mjs") || resolved.endsWith(".js") || resolved.endsWith(".ts")) {
      paths.push(resolved);
    }
  }
  return paths;
}

describe("Plugin manifest MCP server file-path validation", () => {
  test("plugin.json is valid JSON with a name and version", () => {
    const manifest = loadPluginManifest();
    expect(manifest).not.toBeNull();
    expect(typeof manifest?.name).toBe("string");
    expect(typeof manifest?.version).toBe("string");
  });

  test("every mcpServers args file path exists on disk", () => {
    const manifest = loadPluginManifest();
    expect(manifest).not.toBeNull();

    const mcpServers = (manifest?.mcpServers as Record<string, unknown>) ?? {};

    const serverNames = Object.keys(mcpServers);
    expect(serverNames.length).toBeGreaterThan(0);

    for (const serverName of serverNames) {
      const serverDef = mcpServers[serverName] as Record<string, unknown>;
      const args = serverDef.args;

      const fileRefs = collectFilePaths(args);

      for (const relPath of fileRefs) {
        const fullPath = resolve(REPO_ROOT, relPath);
        expect(existsSync(fullPath), `${serverName} -> "${relPath}" does not exist`).toBe(true);
      }
    }
  });

  test("mcpServers is present and well-typed (command + args)", () => {
    const manifest = loadPluginManifest();
    expect(manifest).not.toBeNull();
    expect(typeof manifest?.mcpServers).toBe("object");
    const servers = manifest?.mcpServers as Record<string, unknown> | undefined;
    expect(servers).toBeDefined();

    for (const [name, def] of Object.entries(servers ?? {})) {
      const serverDef = def as Record<string, unknown>;
      expect(typeof serverDef.command, `mcpServers.${name}.command`).toBe("string");
      expect(Array.isArray(serverDef.args), `mcpServers.${name}.args`).toBe(true);
    }
  });
});
