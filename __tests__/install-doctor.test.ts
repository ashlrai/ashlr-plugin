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
  expect(buildInstallManifest(repo)).toEqual(inventory);
});
test("clean fixture passes without writing any files", () => {
  const before = buildInstallManifest(root);
  expect(buildDoctorReport(root)).toEqual({ schemaVersion: 1, ok: true, root, checked: Object.keys(inventory.files).length, issues: [] });
  expect(formatDoctorReport(buildDoctorReport(root))).toContain("ashlr doctor: ok");
  expect(buildInstallManifest(root)).toEqual(before);
});
test("Windows line endings do not look stale", () => {
  const path = join(root, "commands/ashlr-doctor.md");
  writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n"));
  expect(buildDoctorReport(root).ok).toBe(true);
});
test.each([
  ["skills/ashlr-brief/SKILL.md", "missing"],
  ["commands/ashlr-doctor.md", "stale"],
  ["hooks/session-start.ts", "stale"],
] as const)("reports %s as %s with a plain-word fix", (path, status) => {
  if (status === "missing") rmSync(join(root, "skills/ashlr-brief"), { recursive: true });
  else writeFileSync(join(root, path), "old version\n");
  const report = buildDoctorReport(root);
  expect(report.ok).toBe(false);
  expect(report.issues).toEqual([{ path, status, fix: expect.stringContaining("Reinstall Ashlr") }]);
  expect(formatDoctorReport(report)).toContain(`Fix: ${report.issues[0]!.fix}`);
});
test("does not read a hook symlink outside the plugin folder", () => {
  const path = "hooks/session-start.ts";
  rmSync(join(root, path));
  symlinkSync(join(repo, path), join(root, path));
  expect(buildDoctorReport(root).issues).toMatchObject([{ path, status: "unreadable" }]);
});
test("CLI uses its own inventory from another cwd and exits 1 for damage in JSON and text", () => {
  const home = join(root, "home");
  mkdirSync(home);
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(repo, "scripts/cli.ts"), "doctor", "--root", root, ...args],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  expect(run("--json").exitCode).toBe(0);
  const path = "skills/ashlr-brief/SKILL.md";
  writeFileSync(join(root, path), "old version");
  const json = run("--json");
  expect(json.exitCode).toBe(1);
  expect(json.stderr.toString()).toBe("");
  expect(JSON.parse(json.stdout.toString())).toEqual(buildDoctorReport(root));
  const text = run();
  expect(text.exitCode).toBe(1);
  expect(text.stdout.toString()).toBe(formatDoctorReport(buildDoctorReport(root)));
  expect(readFileSync(join(root, path), "utf8")).toBe("old version");
});
