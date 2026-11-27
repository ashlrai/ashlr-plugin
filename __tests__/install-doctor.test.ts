import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import inventory from "../.claude-plugin/install-manifest.json";
import { buildDoctorReport, formatDoctorReport } from "../scripts/lib/install-doctor.ts";
import { buildInstallManifest } from "../scripts/lib/install-manifest.ts";

const repo = resolve(import.meta.dir, "..");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ashlr-install-doctor-"));
  for (const dir of ["skills", "commands", "hooks"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("shipped inventory covers every skill, command and hook and stays current (run bun run doctor:sync)", () => {
  expect(Object.keys(inventory.files).length).toBeGreaterThan(0);
  expect(Object.keys(buildInstallManifest(repo).files).filter(k => k.includes("\\"))).toEqual([]);
  expect(buildInstallManifest(repo)).toEqual(inventory);
});
const byName = (r: { checks: { name: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;

/** A tiny stdio server that answers one JSON-RPC initialize, so the fixture needs no real router. */
function writeFixture(dir: string, servers: Record<string, unknown>) {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "echo-server.mjs"),
    'process.stdin.once("data", () => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n"); });\nsetInterval(() => {}, 1000);\n');
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "demo", version: "1.2.3", mcpServers: servers }));
}
const healthy = { demo: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/echo-server.mjs"] } };

test("healthy install: every check is ok, the report is typed, and nothing is written", async () => {
  writeFixture(root, healthy);
  const before = buildInstallManifest(root);
  const report = await buildDoctorReport(root, { mcpTimeoutMs: 4000 });
  expect(report.ok).toBe(true);
  expect(report.schemaVersion).toBe(1);
  expect(report.checks.map((c) => c.name)).toEqual(["version", "files", "plugin.json", "mcp servers", "mcp demo"]);
  for (const c of report.checks) expect(c).toEqual({ name: c.name, status: "ok", detail: expect.any(String), fix: "" });
  expect(byName(report, "version").detail).toBe("1.2.3");
  expect(formatDoctorReport(report)).toContain("ashlr doctor: ok");
  expect(buildInstallManifest(root)).toEqual(before);
});
test("missing configuration fails with a plain-words fix", async () => {
  const report = await buildDoctorReport(root);
  expect(report.ok).toBe(false);
  expect(byName(report, "version").status).toBe("fail");
  expect(byName(report, "plugin.json")).toMatchObject({ status: "fail", detail: expect.stringContaining("missing"), fix: expect.stringContaining("Reinstall") });
});
test("a server with no command or url is a configuration failure", async () => {
  writeFixture(root, { broken: {} });
  const report = await buildDoctorReport(root);
  expect(byName(report, "server broken")).toMatchObject({ status: "fail", fix: expect.stringContaining("command") });
});
test("unreachable MCP servers fail within the timeout", async () => {
  writeFixture(root, { gone: { command: "ashlr-no-such-command-here" }, web: { url: "http://127.0.0.1:1/" } });
  const start = Date.now();
  const report = await buildDoctorReport(root, { mcpTimeoutMs: 1500 });
  expect(Date.now() - start).toBeLessThan(5000);
  expect(report.ok).toBe(false);
  expect(byName(report, "mcp gone")).toMatchObject({ status: "fail", detail: expect.stringContaining("command not found"), fix: expect.stringContaining("PATH") });
  expect(byName(report, "mcp web")).toMatchObject({ status: "fail", detail: expect.stringContaining("unreachable") });
  expect(formatDoctorReport(report)).toContain("Fix: ");
});
test("a server that never answers times out", async () => {
  writeFixture(root, { quiet: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } });
  const report = await buildDoctorReport(root, { mcpTimeoutMs: 500 });
  expect(byName(report, "mcp quiet").detail).toContain("no answer within");
});
test.each([
  ["skills/ashlr-brief/SKILL.md", "missing"],
  ["commands/ashlr-doctor.md", "stale"],
  ["hooks/session-start.ts", "stale"],
] as const)("reports %s as %s", async (path, status) => {
  writeFixture(root, healthy);
  if (status === "missing") rmSync(join(root, "skills/ashlr-brief"), { recursive: true });
  else writeFileSync(join(root, path), "old version\n");
  const report = await buildDoctorReport(root, { mcpTimeoutMs: 4000 });
  expect(report.ok).toBe(false);
  expect(byName(report, "files")).toMatchObject({ status: "fail", detail: expect.stringContaining(`${status}: ${path}`), fix: expect.stringContaining("Reinstall Ashlr") });
});
test("Windows line endings do not look stale", async () => {
  writeFixture(root, healthy);
  const path = join(root, "commands/ashlr-doctor.md");
  writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n"));
  expect(byName(await buildDoctorReport(root, { mcpTimeoutMs: 4000 }), "files").status).toBe("ok");
});
test("does not read a hook symlink outside the plugin folder", async () => {
  writeFixture(root, healthy);
  const path = "hooks/session-start.ts";
  rmSync(join(root, path));
  symlinkSync(join(repo, path), join(root, path));
  expect(byName(await buildDoctorReport(root, { mcpTimeoutMs: 4000 }), "files").detail).toContain(`unreadable: ${path}`);
});
test("CLI prints versioned JSON, exits 0 when healthy and 1 on a failure", () => {
  writeFixture(root, healthy);
  const home = join(root, "home");
  mkdirSync(home);
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(repo, "scripts/cli.ts"), "doctor", "--root", root, ...args],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const ok = run("--json");
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(ok.stdout.toString())).toMatchObject({ schema: "ashlr-plugin.doctor.v1", schemaVersion: 1, ok: true });
  const path = "skills/ashlr-brief/SKILL.md";
  writeFileSync(join(root, path), "old version");
  const bad = run("--json");
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toBe("");
  expect(JSON.parse(bad.stdout.toString()).checks.find((c: any) => c.name === "files").status).toBe("fail");
  const text = run();
  expect(text.exitCode).toBe(1);
  expect(text.stdout.toString()).toContain("Fix: ");
  expect(readFileSync(join(root, path), "utf8")).toBe("old version");
});
