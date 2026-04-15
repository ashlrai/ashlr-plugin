/**
 * Unit tests for scripts/doctor.ts — exercise buildReport() with mocked
 * probe/fetch/bun deps so we don't actually spawn MCP servers or hit GitHub.
 * One end-to-end test runs the real script against the real install.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, writeFile, mkdir, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  buildReport,
  formatReport,
  probeAll,
  probeServer,
  resolvePluginRoot,
  fetchLatestRelease,
  type ProbeResult,
} from "../scripts/doctor.ts";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function scratchHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ashlr-doctor-"));
}

async function writePluginSkeleton(root: string, version = "0.4.0") {
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "ashlr", version }),
  );
  await mkdir(join(root, "hooks"), { recursive: true });
  for (const h of ["session-start.ts", "tool-redirect.ts", "commit-attribution.ts", "edit-batching-nudge.ts"]) {
    const p = join(root, "hooks", h);
    await writeFile(p, "#!/usr/bin/env bun\n");
    await chmod(p, 0o755);
  }
  await mkdir(join(root, "servers"), { recursive: true });
  for (const s of ["efficiency-server.ts", "sql-server.ts", "bash-server.ts", "tree-server.ts"]) {
    await writeFile(join(root, "servers", s), "// stub\n");
  }
}

const fakeSuccessfulProbe = async (): Promise<ProbeResult[]> => [
  { server: "efficiency", ok: true, tools: ["ashlr__read", "ashlr__grep", "ashlr__edit", "ashlr__savings"] },
  { server: "sql",        ok: true, tools: ["ashlr__sql"] },
  { server: "bash",       ok: true, tools: ["ashlr__bash"] },
  { server: "tree",       ok: true, tools: ["ashlr__tree"] },
];

const fakeFailedProbe = async (): Promise<ProbeResult[]> => [
  { server: "efficiency", ok: false, tools: [], error: "spawn failed" },
  { server: "sql",        ok: false, tools: [], error: "spawn failed" },
  { server: "bash",       ok: false, tools: [], error: "spawn failed" },
  { server: "tree",       ok: false, tools: [], error: "spawn failed" },
];

describe("resolvePluginRoot", () => {
  test("respects CLAUDE_PLUGIN_ROOT env var when valid", () => {
    const r = resolvePluginRoot("/tmp", { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
    expect(r).toBe(PLUGIN_ROOT);
  });
  test("ignores CLAUDE_PLUGIN_ROOT when invalid and walks up", () => {
    const r = resolvePluginRoot(PLUGIN_ROOT, { CLAUDE_PLUGIN_ROOT: "/nonexistent-123" });
    expect(r).toBe(PLUGIN_ROOT);
  });
  test("returns null when not found", () => {
    const r = resolvePluginRoot("/", {});
    expect(r).toBe(null);
  });
});

describe("fetchLatestRelease", () => {
  test("returns null when the endpoint is unreachable", async () => {
    const v = await fetchLatestRelease("http://127.0.0.1:1/not-a-real-host", 500);
    expect(v).toBe(null);
  });
  test("parses tag_name via injected fetch", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 })) as unknown as typeof fetch;
    const v = await fetchLatestRelease("http://example.invalid", 1000, fakeFetch);
    expect(v).toBe("1.2.3");
  });
});

describe("buildReport", () => {
  test("empty node_modules reports the install step", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const install = report.sections.find((s) => s.title === "install")!;
    const nm = install.lines.find((l) => l.label === "node_modules")!;
    expect(nm.status).toBe("fail");
    expect(nm.fix).toContain("bun install");
    expect(nm.fix).toContain(root);
    expect(report.failures).toBeGreaterThan(0);
  });

  test("corrupt stats.json reports unreadable, does not crash", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    await mkdir(join(home, ".ashlr"), { recursive: true });
    await writeFile(join(home, ".ashlr/stats.json"), "{not json");
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const stats = report.sections
      .find((s) => s.title === "runtime state")!
      .lines.find((l) => l.label === "stats.json")!;
    expect(stats.status).toBe("warn");
    expect(stats.detail).toContain("unreadable");
    expect(stats.fix).toContain(".corrupt");
  });

  test("all MCP servers fail → 4 failures, still renders cleanly", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeFailedProbe,
      bunVersion: async () => "1.3.10",
    });
    const mcp = report.sections.find((s) => s.title === "mcp servers")!;
    expect(mcp.lines.every((l) => l.status === "fail")).toBe(true);
    expect(mcp.lines).toHaveLength(4);
    // formatting must succeed
    const text = formatReport(report);
    expect(text).toContain("mcp servers");
    expect(text).toContain("unreachable");
  });

  test("successful probes report correct tool names", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const mcp = report.sections.find((s) => s.title === "mcp servers")!;
    const eff = mcp.lines.find((l) => l.label === "efficiency")!;
    expect(eff.status).toBe("ok");
    expect(eff.detail).toContain("ashlr__read");
    expect(eff.detail).toContain("4 tools");
    const sql = mcp.lines.find((l) => l.label === "sql")!;
    expect(sql.detail).toContain("1 tool:");
  });

  test("unreachable latest-release API → reports unknown", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => null,
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    expect(report.header).toContain("latest: unknown");
  });

  test("missing ~/.claude/settings.json reports defaults", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const settings = report.sections
      .find((s) => s.title === "runtime state")!
      .lines.find((l) => l.label === "settings")!;
    expect(settings.status).toBe("warn");
    expect(settings.detail).toContain("defaults");
    expect(settings.detail).toContain("toolRedirect:on");
  });

  test("status line not installed warns with fix", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude/settings.json"), JSON.stringify({ ashlr: {} }));
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const sl = report.sections
      .find((s) => s.title === "runtime state")!
      .lines.find((l) => l.label === "status line")!;
    expect(sl.status).toBe("warn");
    expect(sl.fix).toContain("install-status-line.ts");
  });

  test("status line wired is ok", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude/settings.json"),
      JSON.stringify({
        ashlr: { attribution: true, toolRedirect: true, editBatchingNudge: true },
        statusLine: { command: "bun run /x/savings-status-line.ts" },
      }),
    );
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const sl = report.sections
      .find((s) => s.title === "runtime state")!
      .lines.find((l) => l.label === "status line")!;
    expect(sl.status).toBe("ok");
  });

  test("toolRedirect:false triggers settings warning", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    const home = await scratchHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude/settings.json"),
      JSON.stringify({ ashlr: { toolRedirect: false } }),
    );
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const settings = report.sections
      .find((s) => s.title === "runtime state")!
      .lines.find((l) => l.label === "settings")!;
    expect(settings.status).toBe("warn");
    expect(settings.detail).toContain("toolRedirect:off");
  });

  test("non-executable hooks produce warnings with chmod fix", async () => {
    const root = await scratchHome();
    await writePluginSkeleton(root);
    // Strip exec bit
    for (const h of ["session-start.ts", "tool-redirect.ts", "commit-attribution.ts", "edit-batching-nudge.ts"]) {
      await chmod(join(root, "hooks", h), 0o644);
    }
    const home = await scratchHome();
    const report = await buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: fakeSuccessfulProbe,
      bunVersion: async () => "1.3.10",
    });
    const hooks = report.sections.find((s) => s.title === "hooks")!;
    const warns = hooks.lines.filter((l) => l.status === "warn");
    expect(warns.length).toBeGreaterThanOrEqual(4);
    expect(warns[0]!.fix).toContain("chmod +x");
  });
});

describe("probeAll timing", () => {
  test("total cap exceeded even if a server hangs", async () => {
    // Use a probe that sleeps forever by spawning a fake script that reads stdin and never writes.
    const hang = join(await scratchHome(), "hang.ts");
    // Loop forever keeps the stdout pipe open past our cap
    await writeFile(hang, "await new Promise(() => {});\n");
    const t0 = Date.now();
    const results = await probeAll(
      [{ name: "hanger", script: hang }],
      /* totalCapMs */ 1500,
      /* perServerTimeoutMs */ 5000,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(results[0]!.ok).toBe(false);
  }, 10000);
});

describe("end-to-end", () => {
  test("script runs against the real plugin install and prints a report", async () => {
    const proc = spawn({
      cmd: ["bun", "run", join(PLUGIN_ROOT, "scripts/doctor.ts")],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("ashlr doctor");
    expect(out).toContain("install");
    expect(out).toContain("mcp servers");
    expect(out).toContain("runtime state");
    expect(out).toContain("hooks");
    expect(out).toMatch(/\d+ warnings? · \d+ failures?/);
  }, 30000);
});
