/**
 * Doctor's Phantom check is metadata only: binary presence and version.
 * It must never run reveal or read secret values.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildReport, getPhantomVersion } from "../scripts/doctor.ts";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ashlr-doctor-phm-"));
}

async function fakeBin(script: string): Promise<string> {
  const dir = await scratch();
  const p = join(dir, "phantom");
  await writeFile(p, script);
  await chmod(p, 0o755);
  return p;
}

describe("getPhantomVersion", () => {
  test("returns the version line and only ever passes --version", async () => {
    const dir = await scratch();
    const log = join(dir, "args.log");
    const bin = await fakeBin(`#!/bin/sh\necho "$@" >> "${log}"\necho "phantom 9.9.9"\n`);
    expect(await getPhantomVersion(bin)).toBe("phantom 9.9.9");
    const args = (await Bun.file(log).text()).trim();
    expect(args).toBe("--version");
    expect(args).not.toContain("reveal");
  });

  test("returns null when the binary is missing", async () => {
    expect(await getPhantomVersion("/nonexistent/phantom-xyz")).toBeNull();
  });

  test("returns null when the binary exits non-zero", async () => {
    const bin = await fakeBin("#!/bin/sh\nexit 3\n");
    expect(await getPhantomVersion(bin)).toBeNull();
  });
});

describe("doctor phantom line", () => {
  async function report(phantomVersion: () => Promise<string | null>) {
    const root = await scratch();
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "ashlr", version: "0.4.0" }));
    const home = await scratch();
    return buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: async () => [],
      bunVersion: async () => "1.3.10",
      phantomVersion,
    });
  }

  test("shows version when installed, without adding a warning", async () => {
    const r = await report(async () => "phantom 0.7.9");
    const line = r.sections.find((s) => s.title === "install")!.lines.find((l) => l.label === "phantom")!;
    expect(line.status).toBe("ok");
    expect(line.detail).toContain("phantom 0.7.9");
    expect(line.detail).toContain("phantom exec --");
  });

  test("says not installed (optional) when absent, still ok", async () => {
    const r = await report(async () => null);
    const line = r.sections.find((s) => s.title === "install")!.lines.find((l) => l.label === "phantom")!;
    expect(line.status).toBe("ok");
    expect(line.detail).toBe("not installed (optional)");
  });
});
