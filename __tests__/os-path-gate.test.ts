import { describe, expect, test } from "bun:test";
import { commitSha } from "../scripts/os-affected-tests.ts";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function osPathGate(paths: string[]): boolean {
  const run = spawnSync("node", ["scripts/os-path-gate.mjs"], {
    input: `${paths.join("\n")}\n`,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(run.stderr || "os-path-gate failed");
  return run.stdout.trim() === "true";
}

describe("OS path gate", () => {
  test("docs-only and unrelated source stay off the OS legs", () => {
    expect(osPathGate([
      "README.md",
      "docs/architecture.md",
      "site/content/docs/tools/index.mdx",
      "servers/efficiency-server.ts",
      "CHANGELOG.md",
    ])).toBe(false);
  });

  test("shell, installers, manifests, lockfiles, workflow and path handling are on", () => {
    for (const path of [
      "docs/install.ps1",
      "docs/install.sh",
      "scripts/install-permissions.ts",
      "package.json",
      "bun.lock",
      ".github/workflows/ci.yml",
      "hooks/hooks.json",
      "scripts/mcp-entrypoint.ts",
      "servers/bash-server.ts",
      "__tests__/genome-portable-paths.test.ts",
    ]) {
      expect(osPathGate([path]), path).toBe(true);
    }
  });
});

describe("per-OS gates stay off CI Gate", () => {
  const ci = readFileSync(join(import.meta.dir, "..", ".github/workflows/ci.yml"), "utf8");
  test("CI Gate needs are unchanged and the new names exist", () => {
    expect(ci).toContain("needs: [fast, secret-shape, linux, other-os, benchmark, integration-windows]");
    for (const name of ["Gate (linux)", "Gate (windows)", "Gate (macos)", "install smoke (linux)", "install smoke (windows)", "install smoke (macos)"]) {
      expect(ci).toContain(`name: ${name}`);
    }
  });
});

describe("per-OS gate script", () => {
  test("passes success and skipped, fails any other result", () => {
    const script = "scripts/os-gate.mjs";
    const ok = spawnSync("node", [script], {
      encoding: "utf8",
      env: { ...process.env, NEEDS: JSON.stringify({ fast: { result: "success" }, linux: { result: "skipped" } }) },
    });
    expect(ok.status).toBe(0);
    const bad = spawnSync("node", [script], {
      encoding: "utf8",
      env: { ...process.env, NEEDS: JSON.stringify({ smoke: { result: "failure" } }) },
    });
    expect(bad.status).not.toBe(0);
  });
});

describe("affected-test base SHA", () => {
  test("only a 40-character commit SHA is accepted", () => {
    const sha = "a".repeat(40);
    expect(commitSha(sha)).toBe(sha);
    expect(commitSha(sha.toUpperCase())).toBe(sha.toUpperCase());
    expect(commitSha(`${sha}^{commit}`)).toBeUndefined();
    expect(commitSha("--output=/tmp/x")).toBeUndefined();
    expect(commitSha(`${sha};touch /tmp/x`)).toBeUndefined();
    expect(commitSha("")).toBeUndefined();
  });
});
