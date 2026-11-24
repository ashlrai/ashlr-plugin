import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("community front door", () => {
  test("the Discord placeholder is the public invite", () => {
    const readme = read("README.md");
    expect(readme).not.toContain("TODO(discord)");
    expect(readme).toContain("https://discord.gg/jBQrSU6XeD");
    expect(readme).toContain("The Dev Shack");
    expect(read("CONTRIBUTING.md")).toContain("https://discord.gg/jBQrSU6XeD");
  });

  test("the code of conduct is Contributor Covenant 2.1 and names a real contact", () => {
    const text = read("CODE_OF_CONDUCT.md");
    expect(text).toContain("Contributor Covenant");
    expect(text).toContain("version 2.1");
    expect(text).toContain("SECURITY.md");
    expect(text).toContain("https://github.com/ashlrai/ashlr-plugin/issues");
    expect(text).not.toContain("INSERT CONTACT METHOD");
    expect(text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });
});

describe("one-command setup", () => {
  test("node setup is the shared implementation", () => {
    const setup = read("scripts/setup.mjs");
    expect(setup).toContain('run(["install", "--frozen-lockfile", "--ignore-scripts"])');
    expect(setup).toContain('run(["run", "smoke:tools"])');
    expect(setup).toContain("shell: false");
    expect(setup).toContain('"win32"');
    expect(setup).not.toMatch(/\bread\b/);
    expect(read("scripts/setup.sh")).toContain("exec node scripts/setup.mjs");
    expect(read("scripts/setup.ps1")).toContain("setup.mjs");
    expect(read("CONTRIBUTING.md")).toContain("### macOS");
    expect(read("CONTRIBUTING.md")).toContain("### Linux");
    expect(read("CONTRIBUTING.md")).toContain("### Windows");
    expect(read("README.md")).toContain("### macOS");
    expect(read("README.md")).toContain("### Windows");
    expect(read("AGENTS.md")).toContain("node scripts/setup.mjs");
    expect(read(".devcontainer/devcontainer.json")).toContain("bash scripts/setup.sh");
  });

  test("setup.mjs succeeds twice, including when the source has CRLF", () => {
    const run = () => Bun.spawnSync(["node", "scripts/setup.mjs"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const first = run();
    const second = run();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(first.stdout.toString()).toContain("ashlr smoke:");
    expect(first.stdout.toString()).toContain("MCP tools registered");
    expect(second.stdout.toString()).toContain("MCP tools registered");

    const dir = mkdtempSync(join(tmpdir(), "ashlr-setup-crlf-"));
    try {
      const crlfPath = join(dir, "setup.mjs");
      writeFileSync(crlfPath, read("scripts/setup.mjs").replace(/\n/g, "\r\n"));
      const check = Bun.spawnSync(["node", "--check", crlfPath], { stdout: "pipe", stderr: "pipe" });
      expect(check.exitCode, check.stderr.toString()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("onnxruntime-node is not a default install", () => {
  test("package.json does not depend on onnxruntime-node", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["onnxruntime-node"]).toBeUndefined();
    expect(pkg.optionalDependencies?.["onnxruntime-node"]).toBeUndefined();
  });

  test("the ONNX docs name the npm 11 allowScripts entry", () => {
    const docs = read("docs/llm-providers.md");
    expect(docs).toContain('"allowScripts"');
    expect(docs).toContain('"onnxruntime-node": true');
    expect(docs).toContain("npm install -g onnxruntime-node --allow-scripts=onnxruntime-node");
    expect(read("AGENTS.md")).toContain('"allowScripts": { "onnxruntime-node": true }');
  });
});
