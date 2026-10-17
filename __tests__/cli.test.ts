import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runCli(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "scripts/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASHLR_CONTEXT_DB_DISABLE: "1", ...extraEnv },
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

  test("help describes each command", async () => {
    const result = await runCli(["--help"]);
    expect(result.stderr).toContain("print the local savings ledger");
    expect(result.stderr).toContain("list the MCP tools the router registers");
    expect(result.stderr).toContain("alias: doctor");
  });

  test("doctor is an alias for codex-doctor", async () => {
    const doctor = await runCli(["doctor", "--json"]);
    const codexDoctor = await runCli(["codex-doctor", "--json"]);
    expect(doctor.code).toBe(codexDoctor.code);
    expect(doctor.stderr).not.toContain("unknown subcommand");
    expect(Object.keys(JSON.parse(doctor.stdout))).toEqual(Object.keys(JSON.parse(codexDoctor.stdout)));
  });

  test("stats --json prints an empty ledger as JSON before any savings exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-cli-empty-home-"));
    try {
      const result = await runCli(["stats", "--json"], { HOME: home, USERPROFILE: home });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { sessions: object; lifetime: { tokensSaved: number } };
      expect(parsed.sessions).toEqual({});
      expect(parsed.lifetime.tokensSaved).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("stats --json --since filters the ledger's per-day totals", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-cli-since-home-"));
    try {
      await mkdir(join(home, ".ashlr"), { recursive: true });
      await writeFile(
        join(home, ".ashlr", "stats.json"),
        JSON.stringify({
          schemaVersion: 2,
          sessions: {},
          lifetime: {
            calls: 3,
            tokensSaved: 30,
            byTool: {},
            byDay: { "2026-10-01": { calls: 1, tokensSaved: 10 }, "2026-10-16": { calls: 2, tokensSaved: 20 } },
          },
        }),
      );
      const result = await runCli(["stats", "--json", "--since", "2026-10-10"], { HOME: home, USERPROFILE: home });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ daily: { "2026-10-16": { calls: 2, tokensSaved: 20 } } });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
