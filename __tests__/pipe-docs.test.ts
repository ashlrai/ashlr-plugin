import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ashlrPipe } from "../servers/pipe-server";
import { __restoreRegistryForTests, __snapshotRegistryForTests, registerTool } from "../servers/_tool-base";

test("site grep examples filter the tool's text and return the documented fallback", async () => {
  const doc = await readFile(new URL("../site/content/docs/tools/pipe.mdx", import.meta.url), "utf8");
  const section = doc.split("## Example — filter TODO output for auth")[1]?.split("## Limitations")[0];
  expect(section).toBeDefined();
  const expr = section!.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
  expect(expr).toBeDefined();
  expect(section).toContain("it returns `No auth lines found`");
  const usage = doc.split("## Usage")[1]?.split("## Parameters")[0];
  const request = JSON.parse(usage!.match(/```json\n([\s\S]*?)\n```/)![1]);

  const snap = __snapshotRegistryForTests();
  const calls: Record<string, unknown>[] = [];
  let output = "";
  try {
    registerTool({
      name: "ashlr__grep", description: "stub", inputSchema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: output }] };
      },
    });
    const ctx = { sessionId: "site-pipe-docs-test", env: process.env };
    const run = async (body: string) => JSON.parse((await ashlrPipe({ expr: body }, ctx)).text);

    expect(await run(expr!)).toBe("No auth lines found");
    output = "No matches found.\n";
    expect(await run(expr!)).toBe("No auth lines found");
    output = "src/other.ts:1:TODO\nsrc/auth.ts:2:TODO fix auth\n";
    expect(await run(expr!)).toBe("src/auth.ts:2:TODO fix auth");
    output = "status: auth search unavailable\n";
    expect(await run(expr!)).toBe("status: auth search unavailable");
    output = Array.from({ length: 21 }, (_, i) => `auth/${i}.ts:1:TODO`).join("\n");
    expect((await run(expr!)).split("\n")).toEqual(output.split("\n").slice(0, 20));
    expect((await run(request.arguments.expr)).split("\n")).toEqual(output.split("\n").slice(0, 5));
    expect(calls.slice(0, 5)).toEqual(Array(5).fill({ pattern: "TODO", cwd: ".", bypassSummary: true }));
    expect(calls[5]).toEqual({ pattern: "TODO", cwd: "/path/to/project" });
  } finally {
    __restoreRegistryForTests(snap);
  }
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

test("internal README documents the catalog's experimental pipe opt-ins", async () => {
  const [catalogText, readme] = await Promise.all([
    readFile(new URL("../servers/_tool-catalog.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/README.md", import.meta.url), "utf8"),
  ]);
  const catalog = JSON.parse(catalogText) as Array<{ name: string; description: string; enableEnv?: string }>;
  const pipe = catalog.find((tool) => tool.name === "ashlr__pipe");
  expect(pipe).toBeDefined();
  expect(pipe!.enableEnv).toBe("ASHLR_PIPE_ENABLE");
  expect(pipe!.description).toMatch(/\[EXPERIMENTAL\].*off by default/i);
  expect(pipe!.description).toContain(`${pipe!.enableEnv}=1`);
  expect(pipe!.description).toContain("ASHLR_PIPE_ALLOW_BASH=1");

  const section = readme.split("## Experimental pipe tool")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toMatch(/`ashlr__pipe`[^\n]*disabled by default/);
  expect(section).toContain(`${pipe!.enableEnv}=1`);
  expect(section).toContain("Only the value `1` enables registration");
  expect(section).toContain("separately disabled by default");
  expect(section).toContain("ASHLR_PIPE_ALLOW_BASH=1");
  expect(section).toContain("[pipe guide](ashlr-pipe.md)");
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
