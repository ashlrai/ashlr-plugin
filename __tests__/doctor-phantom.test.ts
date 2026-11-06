/**
 * Doctor's Phantom check is metadata only: binary presence and version.
 * It must never run reveal or read secret values.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildReport, getPhantomVersion } from "../scripts/doctor.ts";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ashlr-doctor-phm-"));
}

describe("getPhantomVersion", () => {
  test("returns the version line and only ever passes --version", async () => {
    const bin = join(await scratch(), "phantom");
    const calls: unknown[] = [];
    expect(await getPhantomVersion(bin, (command, options) => {
      calls.push({ command, options });
      return { stdout: new Blob(["phantom 9.9.9\nignored second line\n"]).stream(), exited: Promise.resolve(0) };
    })).toBe("phantom 9.9.9");
    expect(calls).toEqual([{ command: [bin, "--version"], options: { stdout: "pipe", stderr: "ignore", stdin: "ignore" } }]);
  });

  test("the default native spawn reads the installed runtime's version on every platform", async () => {
    expect(await getPhantomVersion(process.execPath)).toBe(Bun.version);
  });

  test("returns null when the binary is missing", async () => {
    expect(await getPhantomVersion("/nonexistent/phantom-xyz")).toBeNull();
  });

  test("returns null when the binary exits non-zero", async () => {
    expect(await getPhantomVersion("phantom", () => ({
      stdout: new Blob(["phantom 9.9.9\n"]).stream(), exited: Promise.resolve(3),
    }))).toBeNull();
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
