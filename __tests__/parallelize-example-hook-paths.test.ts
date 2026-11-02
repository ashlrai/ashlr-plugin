import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const sources = {
  command: "commands/ashlr-parallelize.md",
  site: "site/content/docs/skills/parallelize.mdx",
} as const;

// The invocation under `## Examples` whose file arguments live under hooks/.
// Throws unless exactly one example names exactly two distinct hooks/ paths.
const hookExample = (doc: string) => {
  const section = doc.split("## Examples\n")[1]?.split(/\n## /)[0] ?? "";
  const invocations = section
    .split("\n")
    .filter((line) => line.startsWith("/ashlr-parallelize "))
    .map((line) => {
      const match = line.match(/^\/ashlr-parallelize (--code )?"([^"]+)" (.+)$/);
      if (!match) throw new Error(`unparseable parallelize example: ${line}`);
      return { line, task: match[2], files: match[3].split(" ") };
    });
  const hooks = invocations.filter(
    (invocation) => invocation.files.length > 0
      && invocation.files.every((file) => file.startsWith("hooks/")),
  );
  if (hooks.length !== 1) {
    throw new Error("expected exactly one example naming hooks/ paths");
  }
  const { files } = hooks[0];
  if (files.length !== 2 || new Set(files).size !== 2) {
    throw new Error("the hook example must name exactly two distinct hooks/ paths");
  }
  return hooks[0];
};

describe("parallelize hook-path example", () => {
  test("the shared example names the same two hook paths in both documents", () => {
    const command = hookExample(read(sources.command));
    const site = hookExample(read(sources.site));
    expect(site.line).toBe(command.line);
    expect(site.files).toEqual(command.files);
    for (const file of site.files) {
      expect(statSync(join(root, file)).isFile()).toBe(true);
    }
  });

  test("extraction rejects missing or malformed hook examples", () => {
    const site = read(sources.site);
    for (const changed of [
      site.replace(/^\/ashlr-parallelize .*hooks\/.*\n/m, ""),
      site.replace(/^\/ashlr-parallelize .*hooks\/.*/m, "malformed example"),
      site.replace("## Examples\n", "## Other examples\n"),
      site.replace(
        /^(\/ashlr-parallelize .*hooks\/.*)$/m,
        '$1\n/ashlr-parallelize "second hooks example" hooks/a.ts hooks/b.ts',
      ),
    ]) {
      expect(() => hookExample(changed)).toThrow();
    }
  });

  test("comparison catches hook paths drifting between documents", () => {
    const site = read(sources.site);
    const command = hookExample(read(sources.command));
    for (const changed of [
      site.replace(command.files[0], "hooks/pretooluse-other.ts"),
      site.replace(
        `${command.files[0]} ${command.files[1]}`,
        `${command.files[1]} ${command.files[0]}`,
      ),
    ]) {
      expect(hookExample(changed).files).not.toEqual(command.files);
    }
  });
});
