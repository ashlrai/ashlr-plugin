import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  const script = read("scripts/setup.sh");

  test("the script is non-interactive and names macOS and Linux", () => {
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("Darwin|Linux");
    expect(script).toContain("bun install --frozen-lockfile");
    expect(script).toContain("bun run smoke:tools");
    expect(script).not.toMatch(/\bread\b/);
    expect(read("CONTRIBUTING.md")).toContain("bash scripts/setup.sh");
    expect(read("AGENTS.md")).toContain("bash scripts/setup.sh");
    expect(read(".devcontainer/devcontainer.json")).toContain("bash scripts/setup.sh");
  });

  test("setup.sh succeeds twice", () => {
    const run = () => Bun.spawnSync(["bash", "scripts/setup.sh"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const first = run();
    const second = run();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(first.stdout.toString()).toContain("ashlr smoke:");
    expect(first.stdout.toString()).toContain("MCP tools registered");
    expect(second.stdout.toString()).toContain("MCP tools registered");
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
