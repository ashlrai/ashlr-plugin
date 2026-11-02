import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const sources = {
  command: "commands/ashlr-parallelize.md",
  site: "site/content/docs/skills/parallelize.mdx",
} as const;
const docs = Object.fromEntries(
  Object.entries(sources).map(([name, path]) => [name, read(path)]),
) as Record<keyof typeof sources, string>;

const TODO_TASK = "find all TODO comments and summarize them";

// Lines inside the fenced block under `## Examples`, in order.
const exampleLines = (doc: string) =>
  doc.split("## Examples\n")[1]?.split(/\n## /)[0]
    ?.match(/```\n([\s\S]*?)\n```/)?.[1]
    ?.split("\n") ?? [];

// The TODO-summarization invocation, parsed per the command's own grammar:
// `/ashlr-parallelize "<task>" <file...>` — a `--code` prefix cannot match.
const todoExample = (doc: string) => {
  const line = exampleLines(doc).find((l) => l.includes(`"${TODO_TASK}"`));
  const match = line?.match(/^\/ashlr-parallelize "([^"]+)" (.+)$/);
  return match ? { line: match[0], task: match[1], files: match[2].split(/\s+/) } : null;
};

describe("TODO-summarization example stays in sync across command and site docs", () => {
  test("both docs contain the identical TODO-summarization example line", () => {
    const command = todoExample(docs.command);
    const site = todoExample(docs.site);
    expect(command).not.toBeNull();
    expect(site).not.toBeNull();
    expect(site!.line).toBe(command!.line);
    expect(command!.task).toBe(TODO_TASK);
  });

  test("each doc carries exactly one TODO example at the same block position", () => {
    const positions = Object.values(docs).map((doc) => {
      const lines = exampleLines(doc);
      const indexes = lines.flatMap((line, i) => (line.includes(`"${TODO_TASK}"`) ? [i] : []));
      expect(indexes).toHaveLength(1);
      return indexes[0];
    });
    expect(positions[1]).toBe(positions[0]);
  });

  test("the shared example is a valid read-only invocation naming real files", () => {
    const example = todoExample(docs.command);
    expect(example).not.toBeNull();
    expect(example!.line).not.toContain("--code");
    const files = example!.files;
    expect(files.length).toBeGreaterThan(1);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(file).toMatch(/[/.]|^__/);
      expect(statSync(join(root, file)).isFile()).toBe(true);
    }
  });

  test("every doc that quotes the example quotes the shared line verbatim", () => {
    const shared = todoExample(docs.command)!.line;
    for (const path of [
      "docs/parallelize-todo-example-inputs.md",
      "docs/parallelize-example-comparison.md",
      "docs/parallelize-example-reference.md",
    ]) {
      expect(read(path)).toContain(`\n${shared}\n`);
    }
  });

  test("extraction rejects task, file-list, and flag drift", () => {
    const variants = [
      docs.site.replace(`"${TODO_TASK}"`, '"list every FIXME comment"'),
      docs.site.replace(" hooks/pretooluse-bash.ts", ""),
      docs.site.replace(`/ashlr-parallelize "${TODO_TASK}"`, `/ashlr-parallelize --code "${TODO_TASK}"`),
      docs.site.replace(`/ashlr-parallelize "${TODO_TASK}"`, `/ashlr-parallelize ${TODO_TASK}`),
    ];
    for (const changed of variants) {
      expect(changed).not.toBe(docs.site);
      expect(todoExample(changed)?.line ?? null).not.toBe(todoExample(docs.command)!.line);
    }
  });
});
