import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("pipe catalog and documentation", () => {
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
