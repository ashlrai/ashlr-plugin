import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

test("site pipe availability matches the catalog opt-in", async () => {
  const [catalogText, page] = await Promise.all([
    readFile(new URL("../servers/_tool-catalog.json", import.meta.url), "utf8"),
    readFile(new URL("../site/content/docs/tools/pipe.mdx", import.meta.url), "utf8"),
  ]);
  const catalog = JSON.parse(catalogText) as Array<{ name: string; description: string; enableEnv?: string }>;
  const pipe = catalog.find((tool) => tool.name === "ashlr__pipe");
  expect(pipe).toBeDefined();
  expect(pipe!.description).toMatch(/\[EXPERIMENTAL\].*off by default/i);
  expect(pipe!.enableEnv).toBeTruthy();
  expect(pipe!.description).toContain(`${pipe!.enableEnv}=1`);

  const status = page.split("**Status:**")[1]?.split("\n")[0];
  expect(status).toBeDefined();
  expect(status).toMatch(/experimental/i);
  expect(status).toMatch(/not registered by default/i);
  expect(status).toContain(`${pipe!.enableEnv}=1`);
  expect(status).toMatch(/server process environment before starting/i);
  expect(page).toMatch(/server's environment configuration and restart the server/i);
});

test("ctx methods table shows a representative grep output example", async () => {
  const guide = await readFile(new URL("../docs/ashlr-pipe.md", import.meta.url), "utf8");
  const table = guide.split("| Method | Equivalent tool | Args |")[1]?.split("\n\n")[0];
  expect(table).toBeDefined();
  const rows = table!.split("\n").filter((line) => line.startsWith("| `ctx."));
  expect(rows).toHaveLength(5);
  for (const row of rows) {
    expect(row.split("|").length - 2).toBe(4);
  }

  const grepRow = rows.find((line) => line.includes("ctx.grep"))!;
  expect(grepRow).toMatch(/ctx\.grep\(\{ pattern: 'TODO', cwd: '\.' \}\)/);
  const example = grepRow.match(/→ `"([^"]+)"`/)?.[1];
  expect(example).toBeDefined();
  const lines = example!.split("\\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/^[\w./-]+:\d+:\S/);
    const examplePath = line.split(":")[0];
    expect(existsSync(fileURLToPath(new URL(`../${examplePath}`, import.meta.url)))).toBe(false);
  }

  const after = guide.split("Each method returns the tool's text output as a plain string.")[1];
  expect(after).toBeDefined();
  expect(after!.split("\n\n")[0]).toMatch(/representative|depend|vary/i);
});
