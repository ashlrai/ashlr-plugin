import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readme = read("README.md");
const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(m => m[1]!).sort();
const section = (heading: string) => {
  const body = readme.split(`### ${heading}\n`)[1];
  expect(body, `README section: ${heading}`).toBeDefined();
  return body!.split(/\n#{2,3} /)[0]!;
};

test("README slash commands exactly match shipped command files and frontmatter", () => {
  const shipped = readdirSync(join(root, "commands")).filter(n => n.endsWith(".md")).sort();
  const catalog = section("Claude Code slash commands");
  expect(shipped.length).toBeGreaterThan(0);
  expect(names(catalog, /^\| \[`\/([^`]+)`\]/gm)).toEqual(shipped.map(n => n.slice(0, -3)).sort());
  for (const file of shipped) {
    const name = read(`commands/${file}`).match(/^name: (.+)$/m)?.[1];
    expect(file).toBe(`${name}.md`);
    expect(catalog).toContain('[`/' + name + '`](commands/' + file + ')');
  }
});

test("README skills exactly match the directory declared by the plugin manifest", () => {
  const manifest = JSON.parse(read(".codex-plugin/plugin.json"));
  const skillDir = manifest.skills.replace(/^\.\//, "").replace(/\/$/, "");
  const shipped = readdirSync(join(root, skillDir), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const catalog = section("Skills");
  expect(shipped.length).toBeGreaterThan(0);
  expect(names(catalog, /^\| \[`([^`]+)`\]/gm)).toEqual(shipped);
  for (const name of shipped) {
    expect(read(`${skillDir}/${name}/SKILL.md`)).toContain(`name: ${name}\n`);
    expect(catalog).toContain('[`' + name + '`](' + skillDir + '/' + name + '/SKILL.md)');
  }
});

test("README CLI names include every dispatcher entry and launcher handshake", () => {
  const options = section("CLI options");
  for (const name of names(read("scripts/cli.ts"), /^    case "([^"]+)":/gm)) {
    expect(options, name).toMatch(new RegExp(`(?<![\\w-])${name}(?![\\w-])`));
  }
  expect(options).toContain("ashlr-plugin --ashlr-handshake");
});

test("README hook table matches registered events for each host", () => {
  const rows = section("Hooks").split("\n").filter(row => row.startsWith("| `"));
  for (const [index, file] of ["hooks/hooks.json", "hooks/codex-hooks.json"].entries()) {
    const documented = rows.filter(row => !row.split("|")[index + 2]!.includes("None registered"));
    expect(documented.map(row => row.match(/`([^`]+)`/)![1]).sort())
      .toEqual(Object.keys(JSON.parse(read(file)).hooks).sort());
  }
});

test("README starts with at most five get-started steps and expected output", () => {
  const start = readme.split("## Get started\n")[1]!.split("\n## ")[0]!;
  const steps = names(start, /^(\d+)\. /gm);
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.length).toBeLessThanOrEqual(5);
  expect(start).toContain("npm install -g ashlr-plugin@");
  expect(start).toContain("ashlr-plugin tools --json");
  expect(start).toContain("You should see a JSON object");
});

test("README mods claim matches npm package files", () => {
  const files: string[] = JSON.parse(read("package.json")).files;
  const shipsMods = files.some(f => f === "mods" || f === "mods/" || f.startsWith("mods/"));
  expect(readme).toContain(shipsMods ? "The npm package includes `mods/`" : "the npm package omits `mods/`");
});
