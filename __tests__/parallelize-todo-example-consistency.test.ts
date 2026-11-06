import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sources = {
  command: "commands/ashlr-parallelize.md",
  site: "site/content/docs/skills/parallelize.mdx",
} as const;
const docs = Object.fromEntries(
  Object.entries(sources).map(([name, path]) => [name, readFileSync(join(root, path), "utf8")]),
) as Record<keyof typeof sources, string>;

// The TODO-search invocation line inside the fenced block under `## Examples`.
const todoExample = (doc: string) =>
  doc.split("## Examples\n")[1]?.split(/\n## /)[0]
    .match(/^\/ashlr-parallelize "find all TODO comments and summarize them" (.+)$/m);

describe("parallelize TODO-search example consistency", () => {
  test("command and site docs contain the identical TODO-search example command", () => {
    const command = todoExample(docs.command);
    const site = todoExample(docs.site);
    expect(command).not.toBeNull();
    expect(site).not.toBeNull();
    expect(site![0]).toBe(command![0]);
  });

  test("the shared TODO-search example names real file arguments", () => {
    const example = todoExample(docs.command);
    expect(example).not.toBeNull();
    const files = example![1].split(/\s+/);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(file).toMatch(/[/.]/);
      expect(statSync(join(root, file)).isFile()).toBe(true);
    }
  });

  test("the matcher rejects drift in the TODO task or its file arguments", () => {
    const retitled = docs.site.replace(
      '"find all TODO comments and summarize them"',
      '"list every FIXME comment"',
    );
    expect(todoExample(retitled)).toBeNull();
    const fewerFiles = docs.site.replace(" hooks/pretooluse-bash.ts", "");
    expect(todoExample(fewerFiles)![0]).not.toBe(todoExample(docs.command)![0]);
  });
});
