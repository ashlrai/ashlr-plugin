import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const agentFiles = ["README.md", "llms.txt", "llms-full.txt", "FAQ.md", "AGENTS.md", "docs/multi-host-mcp.md", "docs/codex-quickstart.md"];

describe("agent front door", () => {
  test("copy-paste files avoid em dashes and placeholder paths", () => {
    for (const path of agentFiles) {
      const text = read(path);
      expect(text, path).not.toContain("\u2014");
      expect(text, path).not.toContain("/abs/path/");
      expect(text, path).not.toContain("<ASHLR_PLUGIN_ROOT>");
    }
  });

  test("README, llms.txt, and llms-full.txt lead with the same agent contract", () => {
    for (const path of ["README.md", "llms.txt", "llms-full.txt"]) {
      expect(read(path)).toContain("Install with npm, call the CLI with --json, and register the ashlr-mcp server.");
    }
    expect(read("llms.txt")).toContain("llms-full.txt");
    for (const path of ["README.md", "llms-full.txt"]) {
      const text = read(path);
      expect(text).toContain("ashlr-plugin tools --json");
      expect(text).toContain("ashlr-plugin stats --json");
      expect(text).toContain("ASHLR_MCP_HOST\": \"claude-code\"");
      expect(text).toContain("ASHLR_MCP_HOST\": \"cursor\"");
      expect(text).toContain("ASHLR_MCP_HOST = \"codex-cli\"");
      expect(text).toContain("\"command\": \"ashlr-mcp\"");
      expect(text).toContain("command = \"ashlr-mcp\"");
    }
  });

  test("pinned install matches package.json", () => {
    const version = JSON.parse(read("package.json")).version as string;
    for (const path of ["README.md", "FAQ.md"]) {
      expect(read(path)).toContain(`npm install -g ashlr-plugin@${version}`);
    }
  });
});
