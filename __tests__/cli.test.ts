import { describe, expect, test } from "bun:test";

async function runCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe("ashlr-plugin CLI", () => {
  test.each(["--help", "-h", "help"])("explicit %s succeeds with the separate Plugin usage", async (arg) => {
    const result = await runCli([arg]);
    expect(result.code).toBe(0);
    // Preserve the existing usage stream and text; only explicit help succeeds.
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("usage:\n");
    expect(result.stderr).toContain("ashlr-plugin stats --json");
    expect(result.stderr).toContain("ashlr-plugin codex-doctor");
    expect(result.stderr).not.toMatch(/\bashlr (?:stats|tools|codex-doctor)\b/);
  });

  test.each([{ args: [] }, { args: ["not-a-command"] }, { args: ["stats"] }])("invalid or incomplete command %j retains failure usage", async ({ args }) => {
    const result = await runCli(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage:\n");
    expect(result.stderr).toContain("ashlr-plugin stats --json");
    if (args[0] === "not-a-command") {
      expect(result.stderr).toStartWith('ashlr-plugin: unknown subcommand "not-a-command"\n');
    }
  });

  test("version matches its manifest", async () => {
    const version = await runCli(["--version"]);
    const pkg = await Bun.file("package.json").json();
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(`ashlr-plugin ${pkg.version}`);
  });

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
