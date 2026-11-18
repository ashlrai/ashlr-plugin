import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { jsonText, schemaName, withSchema } from "../scripts/lib/json-output.ts";

function run(args: string[], home: string) {
  const p = Bun.spawnSync(["bun", "run", "scripts/cli.ts", ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_CONTEXT_DB_DISABLE: "1" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("--json carries a versioned schema name", () => {
  const home = mkdtempSync(join(tmpdir(), "ashlr-json-"));
  const cases: Array<[string, string[]]> = [
    ["stats", ["stats", "--json"]],
    ["tools", ["tools", "--json"]],
    ["manifest", ["manifest", "--json"]],
    ["doctor", ["doctor", "--json"]],
    ["codex-doctor", ["codex-doctor", "--json"]],
    ["codex-start", ["codex-start", "--json"]],
    ["codex-install", ["codex-install", "--dry-run", "--json"]],
  ];

  for (const [command, args] of cases) {
    test(`${command} names ashlr-plugin.${command}.v1 first`, () => {
      const { out } = run(args, home);
      const parsed = JSON.parse(out);
      expect(Object.keys(parsed)[0]).toBe("schema");
      expect(parsed.schema).toBe(`ashlr-plugin.${command}.v1`);
    });
  }

  test("existing fields stay next to the schema name", () => {
    expect(JSON.parse(run(["stats", "--json"], home).out).lifetime.calls).toBe(0);
    expect(JSON.parse(run(["tools", "--json"], home).out).tools.length).toBeGreaterThan(0);
    expect(JSON.parse(run(["codex-start", "--json"], home).out)).toMatchObject({ ok: true, command: "codex-start" });
  });

  test("human output has no schema line", () => {
    const tools = run(["tools"], home).out;
    expect(tools).toStartWith("ashlr MCP tools (");
    expect(tools).not.toContain("ashlr-plugin.tools.v1");
    expect(run(["codex-start"], home).out).toStartWith("[ashlr] codex-start:");
    expect(run(["doctor"], home).out).not.toContain("ashlr-plugin.doctor.v1");
  });

  test("a missing slice is wrapped, not bare null", () => {
    expect(JSON.parse(run(["stats", "--json", "--session", "nobody"], home).out)).toEqual({
      schema: "ashlr-plugin.stats.v1",
      value: null,
    });
  });

  test("helper puts schema first and never overrides the name", () => {
    expect(schemaName("x")).toBe("ashlr-plugin.x.v1");
    expect(withSchema("x", { a: 1, schema: "other" }).schema).toBe("ashlr-plugin.x.v1");
    expect(jsonText("x", { a: 1 })).toBe('{\n  "schema": "ashlr-plugin.x.v1",\n  "a": 1\n}\n');
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
});
