import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

describe("parallelize example arguments", () => {
  for (const path of ["commands/ashlr-parallelize.md", "site/content/docs/skills/parallelize.mdx"]) {
    test(`${path} explains the shared task and separate file arguments`, () => {
      const doc = readFileSync(join(root, path), "utf8");
      const examples = doc.split("## Examples\n")[1].split("## Steps\n")[0];
      expect(examples).toContain('/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts');
      expect(examples).toContain('`"explain what this module exports"` is the shared task\nprompt');
      expect(examples).toContain('`servers/_pid-alive.ts` and `servers/_run-with-timeout.ts` are separate\nfile arguments, so two agents each apply that prompt to one file');
      expect(examples).toContain('example adds `--code` to select agents that can make the requested edits');
    });
  }
});

describe("parallelize illustrative output", () => {
  for (const path of ["commands/ashlr-parallelize.md", "site/content/docs/skills/parallelize.mdx"]) {
    test(`${path} shows a consistent merged report for the first invocation`, () => {
      const doc = readFileSync(join(root, path), "utf8");
      const section = doc.split("## Illustrative output\n")[1];
      expect(section).toBeDefined();
      expect(section).toContain("this when run from this repository");
      const report = section.match(/```\n([\s\S]*?)\n```/)?.[1];
      expect(report).toBeDefined();

      const files = ["servers/_pid-alive.ts", "servers/_run-with-timeout.ts"];
      expect(report).toContain("## /ashlr-parallelize — 2 agents · task: explain what this module exports");
      expect(Array.from(report!.matchAll(/^### .+$/gm), (match) => match[0]))
        .toEqual(files.map((file) => `### ${file}`));
      for (const file of files) {
        const body = report!.split(`### ${file}\n`)[1].split(/\n### |\n---/)[0];
        expect(body).toMatch(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+`));
      }
      expect(report).toContain(`---\nAgents: 2 · subagent_type: ashlr:ashlr:explore · files: ${files.join(", ")}`);
    });
  }
});


describe("parallelize documentation consistency", () => {
  const command = readFileSync(join(root, "commands/ashlr-parallelize.md"), "utf8");
  const site = readFileSync(join(root, "site/content/docs/skills/parallelize.mdx"), "utf8");

  test("website and command share the same instructions and examples", () => {
    const body = (doc: string) => doc.slice(doc.indexOf("Spawn one sub-agent"));
    expect(body(site)).toBe(body(command));
  });

  test("illustrative citations point to the named exports in real source files", () => {
    const report = command.split("## Illustrative output\n")[1];
    const citations = [...report.matchAll(/`(\w+)`[^`\n]*?\((servers\/[^:]+):(\d+)\)/g)];
    expect(citations.map((match) => match[1])).toEqual([
      "pidAlive", "RunWithTimeoutOptions", "RunWithTimeoutResult", "runWithTimeout",
    ]);
    for (const [, name, file, line] of citations) {
      const sourceLine = readFileSync(join(root, file), "utf8").split("\n")[Number(line) - 1];
      expect(sourceLine).toMatch(new RegExp(`^export (?:interface|(?:async )?function) ${name}\\b`));
    }
  });
});
