import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const reference = read("docs/commands.md");

describe("command documentation coverage", () => {
  test("slash catalog matches shipped commands exactly, with working source links", () => {
    const shipped = readdirSync(join(root, "commands"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3)).sort();
    const documented = [...reference.matchAll(/\| \[`\/([^`]+)`\]\(\.\.\/commands\/([^ )]+)\)/g)];
    expect(documented.map((match) => match[1]).sort()).toEqual(shipped);
    for (const [, name, file] of documented) {
      expect(file).toBe(`${name}.md`);
      expect(existsSync(join(root, "commands", file))).toBe(true);
    }
  });

  test("terminal catalog matches CLI dispatch including aliases", () => {
    const cases = [...read("scripts/cli.ts").matchAll(/^    case "([^"]+)":/gm)]
      .map((match) => match[1]);
    const documented = [...reference.matchAll(/\| `ashlr-plugin ([\w-]+)/g)]
      .map((match) => match[1]);
    const terminal = reference.split("## Claude Code slash commands")[0];
    const aliases = [...terminal.matchAll(/(?:Alias|Aliases): ([^\n]+)/g)]
      .flatMap((match) => [...match[1].matchAll(/`([^`]+)`/g)].map((alias) => alias[1]));
    expect([...documented, ...aliases].sort()).toEqual(cases.sort());
  });

  test("entry points link to the reference without a stale slash-command count", () => {
    for (const path of ["README.md", "docs/README.md"]) {
      expect(read(path)).toContain("commands.md");
      expect(read(path)).not.toMatch(/\d+ slash commands/);
      expect(read(path)).not.toContain("\u2014");
    }
    expect(reference).not.toContain("\u2014");
  });
});
