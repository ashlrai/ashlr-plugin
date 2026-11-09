import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("pipe catalog and documentation", () => {
  test("catalog matches the experimental handler and its registration condition", () => {
    const catalog = JSON.parse(readFileSync(join(root, "servers/_tool-catalog.json"), "utf8")) as Array<{
      name: string;
      description: string;
      enableEnv?: string;
    }>;
    const entries = catalog.filter((tool) => tool.name === "ashlr__pipe");
    expect(entries).toHaveLength(1);
    const pipe = entries[0]!;
    expect(pipe.enableEnv).toBe("ASHLR_PIPE_ENABLE");
    expect(pipe.description).toContain("[EXPERIMENTAL]");
    expect(pipe.description).toContain(`off by default, enable with ${pipe.enableEnv}=1`);

    // Registration happens at import time, so use a fresh registry for each flag value.
    for (const value of [undefined, "0", "1"]) {
      const env: Record<string, string> = { HOME: process.env.HOME!, PATH: process.env.PATH! };
      if (value !== undefined) env[pipe.enableEnv!] = value;
      const child = Bun.spawnSync([process.execPath, "-e", `
        const { getTool } = await import('./servers/_tool-base.ts');
        await import('./servers/pipe-server-handlers.ts');
        process.stdout.write(JSON.stringify(getTool('ashlr__pipe')?.description ?? null));
      `], { cwd: root, env });
      expect(child.exitCode).toBe(0);
      const description = JSON.parse(child.stdout.toString()) as string | null;
      if (value === "1") {
        expect(description).toContain("[EXPERIMENTAL]");
        expect(description).toBe(pipe.description);
      } else {
        expect(description).toBeNull();
      }
    }
  }, 30_000);

  test("both identify pipe as opt-in with the same enablement flag", () => {
    const catalog = JSON.parse(readFileSync(join(root, "servers/_tool-catalog.json"), "utf8")) as Array<{
      name: string;
      description: string;
      enableEnv?: string;
    }>;
    const entries = catalog.filter((tool) => tool.name === "ashlr__pipe");
    expect(entries).toHaveLength(1);
    const pipe = entries[0];
    expect(pipe.enableEnv).toBe("ASHLR_PIPE_ENABLE");
    expect(pipe.description).toMatch(/off by default/i);
    expect(pipe.description).toContain(`enable with ${pipe.enableEnv}=1`);

    const doc = readFileSync(join(root, "docs/ashlr-pipe.md"), "utf8");
    const overview = doc.split("## Overview")[1]?.split("### When to use it")[0];
    expect(overview).toBeDefined();
    expect(overview).toMatch(/opt-in/i);
    expect(overview).toMatch(/off by default/i);
    expect(overview).toContain(`${pipe.enableEnv}=1`);
    const flags = doc.split("### Flags")[1]?.split("### Default ctx")[0];
    expect(flags).toContain(`\`${pipe.enableEnv}=1\` | Registers the tool. Required to use \`ashlr__pipe\``);
  });
});
