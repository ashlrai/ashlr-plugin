import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("/ashlr-parallelize illustrative output", () => {
  test("matches the invocation and cites the exports in each file", () => {
    const command = readFileSync(join(root, "commands/ashlr-parallelize.md"), "utf8");
    const invocation = command.match(/^\/ashlr-parallelize "([^"]+)" (.+)$/m);
    expect(invocation).not.toBeNull();
    const [, task, fileArgs] = invocation!;
    const files = fileArgs!.split(" ");
    const example = command.split("## Illustrative output\n")[1];
    expect(example).toBeDefined();
    const report = example!.match(/```\n([\s\S]*?)\n```/)?.[1];
    expect(report).toBeDefined();
    expect(report).toContain(`## /ashlr-parallelize — ${files.length} agents · task: ${task}`);
    expect(report).toContain(`Agents: ${files.length} · subagent_type: ashlr:ashlr:explore · files: ${files.join(", ")}`);

    const sections = [...report!.matchAll(/^### (.+)\n([^#]+?)(?=\n### |\n---)/gm)];
    expect(sections.map((section) => section[1])).toEqual(files);
    for (const [, file, body] of sections) {
      const lines = readFileSync(join(root, file!), "utf8").split("\n");
      const citations = [...body!.matchAll(/`(\w+)`[^`]*?\(([^():]+):(\d+)/g)];
      expect(citations.length).toBeGreaterThan(0);
      for (const [, symbol, citedFile, line] of citations) {
        expect(citedFile).toBe(file);
        expect(lines[Number(line) - 1]).toMatch(new RegExp(`^export (?:function|interface) ${symbol}\\b`));
      }
    }
  });
});
