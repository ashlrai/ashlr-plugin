/**
 * Unit + fast integration tests for scripts/selftest.ts.
 *
 *   - buildFixture produces a real git repo + isolated HOME
 *   - probeEnv strips session/tier env and points HOME at the fixture
 *   - commandCoverage covers every commands/*.md file (no uncovered)
 *   - evalExpect / evalMcpTranscript verdict logic on synthetic results
 *   - runSelftest --only over fast probes end-to-end
 *
 * The full all-probes sweep lives in selftest.smoke.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  PROBES,
  SKIPPED_COMMANDS,
  buildFixture,
  commandCoverage,
  evalExpect,
  evalMcpTranscript,
  listCliSubcommands,
  listCommandFiles,
  parseSelftestArgs,
  probeEnv,
  runProbe,
  runSelftest,
  type ProbeSpec,
  type RawRun,
} from "../scripts/selftest.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withFixture<T>(fn: (fixture: Awaited<ReturnType<typeof buildFixture>>) => Promise<T>): Promise<T> {
  const fixture = await buildFixture();
  try {
    return await fn(fixture);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

describe("buildFixture", () => {
  test("creates repo + isolated home with the expected files", async () => {
    await withFixture(async (f) => {
      for (const rel of [
        "repo/package.json",
        "repo/README.md",
        "repo/src/index.ts",
        "repo/src/util.ts",
        "repo/src/deep/nested.ts",
        "repo/.ashlrcode/genome/knowledge/base.md",
        "home/.ashlr",
        "home/.claude",
      ]) {
        expect(existsSync(join(f.dir, rel))).toBe(true);
      }
      // bench.ts auto-discovery needs .ts files above 500 bytes.
      for (const rel of ["repo/src/index.ts", "repo/src/util.ts"]) {
        const content = await readFile(join(f.dir, rel), "utf8");
        expect(content.length).toBeGreaterThan(500);
      }
    });
  });

  test("the git flag reflects whether a real repo was created", async () => {
    await withFixture(async (f) => {
      expect(f.git).toBe(existsSync(join(f.repo, ".git")));
    });
  });
});

describe("probeEnv", () => {
  test("points HOME + CLAUDE_PLUGIN_ROOT at fixture/root and sets disables", async () => {
    await withFixture(async (f) => {
      const env = probeEnv(ROOT, f);
      expect(env.HOME).toBe(f.home);
      expect(env.ASHLR_HOME_OVERRIDE).toBe(f.home);
      expect(env.CLAUDE_PLUGIN_ROOT).toBe(ROOT);
      expect(env.ASHLR_API_URL_DISABLE).toBe("1");
      expect(env.ASHLR_TELEMETRY).toBe("off");
      expect(env.PATH).toBeDefined();
    });
  });

  test("strips tier/session overrides so results are deterministic", async () => {
    await withFixture(async (f) => {
      const prev = process.env.ASHLR_PRO_TOKEN;
      const prevTier = process.env.ASHLR_TEST_TIER;
      process.env.ASHLR_PRO_TOKEN = "phm_test_should_not_leak";
      process.env.ASHLR_TEST_TIER = "team";
      try {
        const env = probeEnv(ROOT, f);
        expect(env.ASHLR_PRO_TOKEN).toBeUndefined();
        expect(env.ASHLR_TEST_TIER).toBeUndefined();
        expect(env.ASHLR_SESSION_ID).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.ASHLR_PRO_TOKEN;
        else process.env.ASHLR_PRO_TOKEN = prev;
        if (prevTier === undefined) delete process.env.ASHLR_TEST_TIER;
        else process.env.ASHLR_TEST_TIER = prevTier;
      }
    });
  });
});

describe("command coverage", () => {
  test("every commands/*.md file and CLI subcommand is probed or explicitly skipped", async () => {
    const files = await listCommandFiles(ROOT);
    expect(files).toContain("ashlr-selftest.md");
    const cliSubs = await listCliSubcommands(ROOT);
    expect(cliSubs).toContain("selftest");
    const rows = commandCoverage(files, cliSubs);
    const uncovered = rows.filter((r) => r.status === "uncovered");
    expect(uncovered.map((r) => r.name)).toEqual([]);
    // the selftest's own entries are the canonical example of an explicit skip
    const selftestRow = rows.find((r) => r.name === "ashlr-plugin selftest");
    expect(selftestRow?.status).toBe("skipped");
  });

  test("listCliSubcommands discovers cli.ts switch cases, not flag aliases", async () => {
    const subs = await listCliSubcommands(ROOT);
    for (const expected of ["stats", "tools", "mcp", "codex-doctor", "doctor", "genome-refresh", "version", "help"]) {
      expect(subs).toContain(expected);
    }
    expect(subs).not.toContain("--version");
    expect(subs).not.toContain("-h");
  });

  test("discovery preserves UTF-16 order and deduplicates CLI names", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftest-discovery-"));
    const names = ["z", "a", "B", "é", "😀", "Ａ", "a10", "a2"];
    const expected = ["B", "a", "a10", "a2", "z", "é", "😀", "Ａ"];
    try {
      await mkdir(join(root, "commands"));
      await mkdir(join(root, "scripts"));
      for (const name of names) await writeFile(join(root, "commands", `${name}.md`), "");
      await writeFile(join(root, "scripts", "cli.ts"),
        [...names, "a", "--help"].map(name => `case "${name}":`).join("\n"));
      expect(await listCommandFiles(root)).toEqual(expected.map(name => `${name}.md`));
      expect(await listCliSubcommands(root)).toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("probe ids are unique and every probe names a real command", async () => {
    const ids = PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const files = await listCommandFiles(ROOT);
    const slashNames = new Set(files.map((f) => `/${f.replace(/\.md$/, "")}`));
    for (const probe of PROBES) {
      expect(probe.commands.length).toBeGreaterThan(0);
      for (const cmd of probe.commands) {
        if (cmd.startsWith("/")) {
          expect(slashNames.has(cmd)).toBe(true);
        } else {
          expect(cmd.startsWith("ashlr-plugin ")).toBe(true);
        }
      }
    }
  });

  test("skipped commands all have a reason and no probe", () => {
    for (const [name, reason] of Object.entries(SKIPPED_COMMANDS)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(PROBES.some((p) => p.commands.includes(name))).toBe(false);
    }
  });
});

describe("evalExpect", () => {
  const base: ProbeSpec = {
    id: "t", commands: ["/x"],
    run: { kind: "script", argv: ["scripts/x.ts", "--json"] },
  };
  const ok: RawRun = { stdout: "{}", stderr: "", exitCode: 0, timedOut: false };

  test("exit 0 with no expectations passes", () => {
    const v = evalExpect(base, { ...ok, stdout: "plain text" });
    expect(v.status).toBe("ok");
    expect(v.json).toBeNull();
  });

  test("unexpected exit code fails with the stderr excerpt", () => {
    const v = evalExpect(base, { stdout: "", stderr: "boom\nmore", exitCode: 3, timedOut: false });
    expect(v.status).toBe("fail");
    expect(v.summary).toContain("exit 3");
    expect(v.summary).toContain("boom");
  });

  test("expected nonzero exit passes and marks the summary", () => {
    const probe = { ...base, expect: { exit: [0, 2] } };
    const v = evalExpect(probe, { ...ok, exitCode: 2 });
    expect(v.status).toBe("ok");
    expect(v.summary).toContain("exit 2 (expected)");
  });

  test("json expectation fails on non-JSON stdout", () => {
    const probe = { ...base, expect: { json: true } };
    const v = evalExpect(probe, { ...ok, stdout: "not json" });
    expect(v.status).toBe("fail");
    expect(v.summary).toContain("not JSON");
  });

  test("json expectation passes and runs checkJson", () => {
    const probe: ProbeSpec = {
      ...base,
      expect: { json: true, checkJson: (p) => ((p as { n?: number }).n === 1 ? null : "n missing") },
    };
    expect(evalExpect(probe, { ...ok, stdout: '{"n":1}' }).status).toBe("ok");
    const bad = evalExpect(probe, { ...ok, stdout: '{"n":2}' });
    expect(bad.status).toBe("fail");
    expect(bad.summary).toContain("n missing");
  });

  test("outputIncludes searches stdout+stderr combined", () => {
    const probe = { ...base, expect: { outputIncludes: "needle" } };
    expect(evalExpect(probe, { ...ok, stderr: "hay needle stack" }).status).toBe("ok");
    expect(evalExpect(probe, { ...ok }).status).toBe("fail");
  });

  test("timeout is a failure before any other check", () => {
    const probe = { ...base, expect: { exit: [0, 1] } };
    const v = evalExpect(probe, { stdout: "", stderr: "", exitCode: -1, timedOut: true });
    expect(v.status).toBe("fail");
    expect(v.summary).toContain("timed out");
  });
});

describe("evalMcpTranscript", () => {
  const calls = [{ name: "ashlr__read" }, { name: "ashlr__savings" }];
  const line = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

  test("counts tools and validates each tools/call", () => {
    const stdout = [
      line(1, { protocolVersion: "2024-11-05" }),
      line(2, { tools: new Array(40).fill({ name: "x" }) }),
      line(100, { content: [{ type: "text", text: "ok" }] }),
      line(101, { content: [{ type: "text", text: "ok" }] }),
      "some non-json log line",
    ].join("\n");
    const { tools, callErrors } = evalMcpTranscript(stdout, calls);
    expect(tools).toBe(40);
    expect(callErrors).toEqual([]);
  });

  test("flags isError results and missing responses", () => {
    const stdout = [
      line(2, { tools: [] }),
      line(100, { isError: true, content: [] }),
      // no id=101 response at all
    ].join("\n");
    const { tools, callErrors } = evalMcpTranscript(stdout, calls);
    expect(tools).toBe(0);
    expect(callErrors.join("; ")).toContain("ashlr__read: tool returned isError");
    expect(callErrors.join("; ")).toContain("ashlr__savings: no response");
  });
});

describe("parseSelftestArgs", () => {
  test("parses --json, --only (space and =), --keep-tmp, --timeout-ms", () => {
    const opts = parseSelftestArgs(["--json", "--only", "a,b", "--keep-tmp", "--timeout-ms", "5000"]);
    expect(opts).toMatchObject({ json: true, only: ["a", "b"], keepTmp: true, timeoutMs: 5000 });
    const eq = parseSelftestArgs(["--only=c:d", "--timeout-ms=1000"]);
    expect(eq.only).toEqual(["c:d"]);
    expect(eq.timeoutMs).toBe(1000);
  });
});

describe("runProbe", () => {
  test("a missing script fails cleanly instead of throwing", async () => {
    await withFixture(async (f) => {
      const probe: ProbeSpec = {
        id: "missing", commands: ["/x"],
        run: { kind: "script", argv: ["scripts/does-not-exist.ts", "--json"] },
        timeoutMs: 20_000,
      };
      const result = await runProbe(ROOT, f, probe);
      expect(result.status).toBe("fail");
      expect(result.exitCode).not.toBe(0);
    });
  });
});

describe("runSelftest (--only subset)", () => {
  test("cli:version probe passes and the report envelope is well-formed", async () => {
    const { report, code } = await runSelftest({ only: ["cli:version"] });
    expect(code).toBe(0);
    expect(report.kind).toBe("ashlr.selftest");
    expect(report.schema_version).toBe(1);
    expect(report.status).toBe("ok");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.id).toBe("cli:version");
    expect(report.checks[0]!.exitCode).toBe(0);
    // --only still audits coverage: every command file gets a row.
    expect(report.commands.length).toBeGreaterThan(30);
  });

  test("cli:stats emits valid JSON under the fixture HOME", async () => {
    const { report, code } = await runSelftest({ only: ["cli:stats"] });
    expect(code).toBe(0);
    const check = report.checks.find((c) => c.id === "cli:stats");
    expect(check?.status).toBe("ok");
    expect(check?.json).toBe(true);
  });

  test("--only by slash command name selects its probes", async () => {
    const { report } = await runSelftest({ only: ["ashlr-plugin version"] });
    expect(report.checks.map((c) => c.id)).toEqual(["cli:version"]);
  });
});
