import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const sources = [
  "commands/ashlr-parallelize.md",
  "site/content/docs/skills/parallelize.mdx",
] as const;

test("locations guide identifies both documentation locations", () => {
  const guide = read("docs/parallelize-command-locations.md");
  for (const path of sources) {
    expect(guide).toContain(`](../${path})`);
  }
  expect(guide).toContain("`name`");
  expect(guide).toContain("`argument-hint`");
  expect(guide).toContain("`title`");
  expect(read("docs/README.md")).toContain("(parallelize-command-locations.md)");
});

test("locations guide shows the shared example invocation verbatim", () => {
  const firstExample = (doc: string) =>
    doc.split("## Examples\n")[1]?.match(/^\/ashlr-parallelize "[^"]+" .+$/m)?.[0];
  const [commandExample, siteExample] = sources.map((path) => firstExample(read(path)));
  expect(commandExample).toBeDefined();
  expect(siteExample).toBe(commandExample);

  const guide = read("docs/parallelize-command-locations.md");
  expect(guide).toContain(`\`\`\`text\n${commandExample}\n\`\`\``);
});

test("locations guide describes the identical bodies it maps", () => {
  const body = (doc: string) => doc.slice(doc.indexOf("Spawn one sub-agent"));
  const [command, site] = sources.map(read);
  expect(body(site)).toBe(body(command));
  expect(read("docs/parallelize-command-locations.md")).toContain("identical");
});
