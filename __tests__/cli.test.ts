import { describe, expect, test } from "bun:test";

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "scripts/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASHLR_CONTEXT_DB_DISABLE: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("ashlr CLI", () => {
  test("tools --json lists the registered MCP tools", async () => {
    const result = await runCli(["tools", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      count: number;
      tools: Array<{ name: string; description: string }>;
    };
    expect(parsed.count).toBe(40);
    expect(parsed.tools.map((t) => t.name)).toContain("ashlr__read");
    expect(parsed.tools.map((t) => t.name)).toContain("ashlr__grep");
    expect(parsed.tools.map((t) => t.name)).toContain("ashlr__write");
  });

  test("tools renders a readable text list by default", async () => {
    const result = await runCli(["tools"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ashlr MCP tools (40)");
    expect(result.stdout).toContain("ashlr__read");
    expect(result.stdout).toContain("ashlr__search_replace_regex");
  });
});
