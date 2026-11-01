import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sources = {
  command: "commands/ashlr-parallelize.md",
  site: "site/content/docs/skills/parallelize.mdx",
} as const;

const docs = Object.fromEntries(
  Object.entries(sources).map(([name, path]) => [name, readFileSync(join(root, path), "utf8")]),
) as Record<keyof typeof sources, string>;

// Invocation lines from the fenced block under `## Examples`.
const exampleInvocations = (doc: string) => {
  const section = doc.split("## Examples\n")[1]?.split(/\n## /)[0] ?? "";
  const block = section.match(/```\n([\s\S]*?)\n```/)?.[1] ?? "";
  return block.split("\n").filter((line) => line.startsWith("/ashlr-parallelize "));
};

// Every line invoking /ashlr-parallelize, in order (usage line plus examples).
const allInvocations = (doc: string) =>
  doc.split("\n").filter((line) => line.startsWith("/ashlr-parallelize "));

// `/ashlr-parallelize [--code] "<task>" <file...>` → parsed parts, or null.
const parseInvocation = (line: string) => {
  const match = line.match(/^\/ashlr-parallelize (--code )?"([^"]+)" (.+)$/);
  if (!match) return null;
  const [, flag, task, fileArgs] = match;
  return { code: flag !== undefined, task, files: fileArgs.split(" ") };
};

// The fenced report under `## Illustrative output`.
const report = (doc: string) =>
  doc.split("## Illustrative output\n")[1]?.match(/```\n([\s\S]*?)\n```/)?.[1] ?? "";

describe("parallelize example parity", () => {
  for (const [name, path] of Object.entries(sources)) {
    test(`${name} (${path}) documents parseable /ashlr-parallelize examples`, () => {
      const invocations = exampleInvocations(readFileSync(join(root, path), "utf8"));
      expect(invocations.length).toBeGreaterThan(0);
      for (const line of invocations) expect(parseInvocation(line)).not.toBeNull();
    });
  }

  test("the Examples block lists identical invocations in both docs", () => {
    expect(exampleInvocations(docs.site)).toEqual(exampleInvocations(docs.command));
  });

  test("every /ashlr-parallelize invocation line matches across both docs", () => {
    expect(allInvocations(docs.site)).toEqual(allInvocations(docs.command));
  });

  test("the shared example names the same task and files in both docs", () => {
    const shared = Object.values(docs).map((doc) =>
      parseInvocation(exampleInvocations(doc)[0] ?? ""));
    expect(shared[0]).not.toBeNull();
    expect(shared[1]).toEqual(shared[0]);
  });

  test("the input guide identifies both sources and the shared example", () => {
    const guide = readFileSync(join(root, "docs/parallelize-example-inputs.md"), "utf8");
    const examples = exampleInvocations(docs.command);
    const shared = parseInvocation(examples[0] ?? "");
    expect(shared).not.toBeNull();
    for (const path of Object.values(sources)) expect(guide).toContain(`../${path}`);
    expect(examples).toHaveLength(3);
    expect(guide).toContain("all three invocation lines are identical");
    expect(guide).toContain(examples[0]);
    expect(guide).toContain(`\`${shared!.task}\``);
    for (const file of shared!.files) expect(guide).toContain(`\`${file}\``);
  });

  test("each doc's illustrative report stays consistent with its shared example", () => {
    for (const doc of Object.values(docs)) {
      const shared = parseInvocation(exampleInvocations(doc)[0] ?? "");
      expect(shared).not.toBeNull();
      const output = report(doc);
      expect(output).toContain(`task: ${shared!.task}`);
      expect(output).toContain(`Agents: ${shared!.files.length}`);
      expect(output).toContain(`files: ${shared!.files.join(", ")}`);
      for (const file of shared!.files) expect(output).toContain(`### ${file}`);
    }
  });
});
