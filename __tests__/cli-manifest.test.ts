import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildPluginManifest, formatPluginManifest } from "../scripts/lib/plugin-manifest.ts";
import { buildProduct } from "../site/scripts/freshness.ts";

const repo = resolve(import.meta.dir, "..");
let root: string;
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const run = (args: string[], packageRoot = repo) => Bun.spawnSync(
  [process.execPath, join(packageRoot, "scripts/cli.ts"), ...args],
  // Bun's own transpiler cache lands under HOME (Library/Caches or .bun) on newer
  // runtimes; disable it so only plugin-written state could change the snapshot.
  { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } },
);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ashlr-manifest-"));
  for (const dir of ["commands", "skills"]) mkdirSync(join(root, dir));
  write(".claude-plugin/plugin.json", JSON.stringify({ name: "fixture", version: "1.2.3" }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("empty manifest stays versioned and renders without missing rows", () => {
  const manifest = buildPluginManifest(root);
  expect(manifest).toEqual({ schemaVersion: 1, name: "fixture", version: "1.2.3", commands: [], skills: [] });
  expect(formatPluginManifest(manifest)).toContain("Slash commands (0)\nSkills (0)");
  // A package-shaped fixture proves the CLI needs neither site files nor caller metadata.
  for (const path of ["scripts/cli.ts", "scripts/lib/codex-doctor.ts", "scripts/lib/plugin-manifest.ts", "scripts/lib/json-output.ts"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  const result = run(["manifest", "--json"], root);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual({ schema: "ashlr-plugin.manifest.v1", ...manifest });
});

test("normal manifest includes all names, YAML descriptions, and portable source paths in stable order", () => {
  write("commands/z.md", '---\nname: z\ndescription: "Last: command"\n---\n');
  write("commands/a.md", "---\r\nname: a\r\ndescription: >-\r\n  First command\r\n  across lines\r\n---\r\n");
  write("commands/_data.json", "{}");
  write("skills/custom/SKILL.md", "---\nname: custom\ndescription: 'A user''s skill'\n---\n");
  write("skills/README.md", "Not a skill");
  const manifest = buildPluginManifest(root);
  expect(manifest.commands).toEqual([
    { name: "a", description: "First command across lines", path: "commands/a.md" },
    { name: "z", description: "Last: command", path: "commands/z.md" },
  ]);
  expect(manifest.skills).toEqual([{ name: "custom", description: "A user's skill", path: "skills/custom/SKILL.md" }]);
  expect(buildPluginManifest(root)).toEqual(manifest);
});

test.each(["name: wrong\ndescription: valid", "name: broken\ndescription: []", "name: ["])(
  "invalid metadata fails without silently dropping instructions: %s", metadata => {
    write("commands/broken.md", `---\n${metadata}\n---\n`);
    expect(() => buildPluginManifest(root)).toThrow("Invalid instruction metadata: commands/broken.md");
  },
);

test("CLI lists every shipped instruction from its install, agrees with docs, and writes no user state", () => {
  const before = readdirSync(root);
  const result = run(["manifest", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const manifest = buildPluginManifest(repo);
  expect(JSON.parse(result.stdout.toString())).toEqual({ schema: "ashlr-plugin.manifest.v1", ...manifest });
  // Glob uses native separators on Windows; manifest paths must stay portable.
  expect(manifest.commands.map(entry => entry.path)).toEqual([...new Bun.Glob("commands/*.md").scanSync({ cwd: repo })].map(path => path.replaceAll("\\", "/")).sort());
  expect(manifest.skills.map(entry => entry.path)).toEqual([...new Bun.Glob("skills/*/SKILL.md").scanSync({ cwd: repo })].map(path => path.replaceAll("\\", "/")).sort());
  const product = buildProduct(repo);
  const rows = (entries: typeof manifest.skills) => entries.map(({ name, description }) => ({ name, description: description.replace(/\u2014/g, ";") }));
  expect(rows(manifest.commands)).toEqual(product.commands);
  expect(rows(manifest.skills)).toEqual(product.workflowSkills);
  expect(manifest.version).toBe(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version);
  const text = run(["manifest"]);
  expect(text.exitCode).toBe(0);
  expect(text.stdout.toString()).toBe(formatPluginManifest(manifest));
  expect(run(["help"]).stderr.toString()).toContain("list every shipped skill and slash command");
  expect(readdirSync(root)).toEqual(before);
});
