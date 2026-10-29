import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

describe("parallelize example arguments", () => {
  for (const path of ["commands/ashlr-parallelize.md", "site/content/docs/skills/parallelize.mdx"]) {
    test(`${path} explains the shared task and separate file arguments`, () => {
      const doc = readFileSync(join(root, path), "utf8");
      const examples = doc.split("## Examples\n")[1].split("## Steps\n")[0];
      expect(examples).toContain('/ashlr-parallelize "explain what this module exports" src/utils.ts src/helpers.ts src/types.ts');
      expect(examples).toContain('`"explain what this module exports"` is the shared task\nprompt');
      expect(examples).toContain('`src/utils.ts`, `src/helpers.ts`, and `src/types.ts` are three separate\nfile arguments, so three agents each apply that prompt to one file');
      expect(examples).toContain('example adds `--code` to select agents that can make the requested edits');
    });

    test(`${path} explains the TODO example's instruction and file arguments`, () => {
      const doc = readFileSync(join(root, path), "utf8");
      const examples = doc.split("## Examples\n")[1].split("## Steps\n")[0];
      expect(examples).toContain('/ashlr-parallelize "find all TODO comments and summarize them" hooks/pretooluse-read.ts hooks/pretooluse-bash.ts');
      expect(examples).toMatch(/`"find all TODO comments and summarize them"` is the\s+shared instruction/);
      expect(examples).toMatch(/`hooks\/pretooluse-read\.ts` and `hooks\/pretooluse-bash\.ts`\s+are the two file arguments, so each gets an agent with that instruction/);
    });
  }
});
