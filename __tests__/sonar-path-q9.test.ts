import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveCommand } from "../scripts/resolve-command";

const originalPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subprocess command resolution", () => {
  test("resolves PATH entries to an absolute executable and accepts explicit paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "sonar-path-"));
    dirs.push(dir);
    const executable = join(dir, "test-command");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    process.env.PATH = dir;
    expect(resolveCommand("test-command")).toBe(executable);
    expect(isAbsolute(resolveCommand(executable))).toBe(true);
  });

  test("fails closed when the executable is absent", () => {
    process.env.PATH = "";
    expect(() => resolveCommand("missing-q9-command")).toThrow("Executable not found");
  });
});
