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

  test("every slash command has a matching invocation and a nonempty output excerpt", () => {
    const slashSection = reference.split("## Claude Code slash commands")[1].split("## Common workflows")[0];
    expect(slashSection).toContain("| Command | Purpose | Example output |");
    const rows = slashSection.split("\n").filter((line) => line.startsWith("| [`/"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      expect(cells).toHaveLength(5);
      const name = cells[1].match(/^\[`\/([^`]+)`\]/)?.[1];
      const example = cells[3].match(/^`\/([^`]+)` → `([^`]+)`$/);
      expect(name).toBeDefined();
      expect(example).not.toBeNull();
      expect(example![1].split(" ")[0]).toBe(name ?? "");
      expect(example![2].trim().length).toBeGreaterThan(0);
    }
  });

  test("representative fixed output excerpts match their command sources", () => {
    for (const [command, excerpt] of [
      ["ashlr-brief", "ashlr-brief: standard ON. Effective on the next response."],
      ["ashlr-eco-mode", "Eco mode OFF. All behaviors restored to defaults."],
      ["ashlr-genome-loop", "ashlr genome loop: disabled"],
      ["ashlr-orchestrate", "Press y to execute, n to cancel, e to edit YAML."],
      ["ashlr-team-invite", "Expires in 7 days."],
    ]) {
      expect(reference).toContain(excerpt);
      const source = read(`commands/${command}.md`);
      expect(source.replace("<level>", "standard")).toContain(excerpt);
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
