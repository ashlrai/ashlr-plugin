import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("TODO example returns the documented fallback or matching lines", async () => {
  const doc = await readFile(new URL("../site/content/docs/tools/pipe.mdx", import.meta.url), "utf8");
  const section = doc.split("## Example — find all TODO comments in auth files")[1]?.split("## Limitations")[0];
  expect(section).toBeDefined();
  const expr = section!.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
  expect(expr).toBeDefined();
  expect(section).toContain("it returns `No TODOs found`");

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("glob", "read", "cwd", expr!);
  const readPaths: string[] = [];
  const read = async (path: string) => {
    readPaths.push(path);
    return path === "auth/match.ts" ? "first line\n// TODO: fix auth\nlast line" : "no tasks here";
  };

  expect(await run(async () => [], read, ".")).toBe("No TODOs found");
  expect(await run(async () => ["auth/clean.ts"], read, ".")).toBe("No TODOs found");
  expect(await run(async () => ["auth/clean.ts", "auth/match.ts"], read, "."))
    .toBe("auth/match.ts:\n// TODO: fix auth");

  readPaths.length = 0;
  expect(await run(async () => [...Array(20).fill("auth/clean.ts"), "auth/match.ts"], read, "."))
    .toBe("No TODOs found");
  expect(readPaths).toHaveLength(20);
});

test("pipe guide documents the catalog's experimental opt-in", async () => {
  const [catalogText, guide] = await Promise.all([
    readFile(new URL("../servers/_tool-catalog.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8"),
  ]);
  const catalog = JSON.parse(catalogText) as Array<{
    name: string;
    description: string;
    enableEnv?: string;
  }>;
  const pipe = catalog.find((tool) => tool.name === "ashlr__pipe");
  expect(pipe).toBeDefined();
  expect(pipe!.description).toContain("[EXPERIMENTAL]");
  expect(pipe!.enableEnv).toBeTruthy();

  const overview = guide.split("## Overview")[1].split("### When to use it")[0];
  expect(overview).toMatch(/experimental/i);
  expect(overview).toMatch(/off by default/i);
  expect(overview).toContain(`${pipe!.enableEnv}=1`);
  expect(guide).toContain(`"${pipe!.enableEnv}": "1"`);
  expect(overview).toContain("ASHLR_PIPE_ALLOW_BASH=1");
});
