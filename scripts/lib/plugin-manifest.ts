import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ManifestEntry { name: string; description: string; path: string }
export interface PluginManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  commands: ManifestEntry[];
  skills: ManifestEntry[];
}

// Declared locally so the file type-checks in the Next site build, which has no Bun types.
const parseYaml = (input: string): unknown =>
  (globalThis as unknown as { Bun: { YAML: { parse(input: string): unknown } } }).Bun.YAML.parse(input);

/** Read shipped instructions only; discovery never runs them. */
export function readManifestEntries(root: string, directory: "commands" | "skills"): ManifestEntry[] {
  const entries = readdirSync(join(root, directory), { withFileTypes: true });
  return entries.filter(entry => directory === "commands"
    ? entry.isFile() && entry.name.endsWith(".md") : entry.isDirectory())
    .map(entry => entry.name).sort((a, b) => Number(a > b) - Number(a < b)).map(file => {
      const path = directory === "commands" ? `commands/${file}` : `skills/${file}/SKILL.md`;
      const source = readFileSync(join(root, path), "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      let meta: { name?: unknown; description?: unknown } | null = null;
      try { meta = frontmatter ? parseYaml(frontmatter) as { name?: unknown; description?: unknown } : null; } catch { /* reject below */ }
      const expected = directory === "commands" ? file.slice(0, -3) : file;
      if (meta?.name !== expected || typeof meta.description !== "string" || !meta.description.trim()) {
        throw new Error(`Invalid instruction metadata: ${path}`);
      }
      return { name: expected, description: meta.description.trim(), path };
    });
}

/** Extend the installed plugin manifest with a versioned instruction inventory. */
export function buildPluginManifest(root: string): PluginManifest {
  const { name, version } = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  if (typeof name !== "string" || !name.trim() || typeof version !== "string" || !version.trim()) {
    throw new Error("Invalid plugin name or version");
  }
  return { schemaVersion: 1, name, version,
    commands: readManifestEntries(root, "commands"), skills: readManifestEntries(root, "skills") };
}

export function formatPluginManifest(manifest: PluginManifest): string {
  const rows = (entries: ManifestEntry[], prefix = "") => entries.map(entry => `${prefix}${entry.name}  ${entry.description}`);
  return [`${manifest.name} ${manifest.version}`, `Slash commands (${manifest.commands.length})`,
    ...rows(manifest.commands, "/"), `Skills (${manifest.skills.length})`, ...rows(manifest.skills),
    "Read the source paths from: ashlr-plugin manifest --json"].join("\n") + "\n";
}
