/**
 * The catalog documents the experimental execution tool's opt-in: the
 * ashlr__pipe entry carries `enableEnv` and its description tells users to
 * set that variable to `1`. These tests verify the documented flag actually
 * makes the tool available through `ashlr-plugin tools` — the eager registry
 * path in servers/_router-handlers.ts that the CLI, smoke tests and the
 * catalog generator share. The lazy stdio router is covered in
 * router-lazy-handshake.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import catalog from "../servers/_tool-catalog.json" with { type: "json" };

interface ToolSpec {
  name: string;
  description: string;
  enableEnv?: string;
}

const allTools = catalog as ToolSpec[];
const gated = allTools.filter((tool) => tool.enableEnv);
const defaultCount = allTools.length - gated.length;

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "cli.ts");

async function runTools(
  args: readonly string[],
  home: string,
  flag: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    ASHLR_STATS_SYNC: "1",
    ASHLR_SESSION_LOG: "0",
    ASHLR_MCP_HOST: "generic",
    ASHLR_CONTEXT_DB_DISABLE: "1",
  };
  for (const tool of gated) delete env[tool.enableEnv!];
  if (flag !== undefined) {
    for (const tool of gated) env[tool.enableEnv!] = flag;
  }
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("experimental execution opt-in (catalog enableEnv)", () => {
  test("the catalog documents ashlr__pipe's opt-in flag", () => {
    const pipe = gated.find((tool) => tool.name === "ashlr__pipe");
    expect(pipe).toBeDefined();
    expect(pipe!.enableEnv).toBe("ASHLR_PIPE_ENABLE");
    expect(pipe!.description).toContain("[EXPERIMENTAL]");
    expect(pipe!.description).toMatch(/off by default/i);
    expect(pipe!.description).toContain(`enable with ${pipe!.enableEnv}=1`);
  });

  test.each([undefined, "", "0", "true", "1 "])(
    "tools --json hides gated tools when the flag is %j",
    async (flag) => {
      const home = await mkdtemp(join(tmpdir(), "ashlr-opt-in-off-"));
      try {
        const result = await runTools(["tools", "--json"], home, flag);
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout) as {
          count: number;
          tools: Array<{ name: string }>;
        };
        expect(parsed.count).toBe(defaultCount);
        for (const tool of gated) {
          expect(parsed.tools.map((t) => t.name)).not.toContain(tool.name);
        }
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    },
    30_000,
  );

  test("tools --json lists the execution tool when the documented opt-in is enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-opt-in-on-"));
    try {
      const result = await runTools(["tools", "--json"], home, "1");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as {
        count: number;
        tools: Array<{ name: string; description: string }>;
      };
      expect(parsed.count).toBe(allTools.length);
      for (const tool of gated) {
        const listed = parsed.tools.find((t) => t.name === tool.name);
        expect(listed?.description).toBe(tool.description);
      }
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("tools text output marks the enabled tool experimental", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-opt-in-text-"));
    try {
      const result = await runTools(["tools"], home, "1");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`ashlr MCP tools (${allTools.length})`);
      for (const tool of gated) {
        const line = result.stdout.split("\n").find((l) => l.startsWith(`${tool.name} `));
        expect(line).toContain("[EXPERIMENTAL]");
      }
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
