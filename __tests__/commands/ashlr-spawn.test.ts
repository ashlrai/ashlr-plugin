/**
 * Verifies ashlr-spawn.md references all 5 patterns and _spawn-patterns.json.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "../../commands");

async function readCommand(name: string): Promise<string> {
  return readFile(join(commandsDir, `${name}.md`), "utf8");
}

const REQUIRED_PATTERNS = [
  "triage-issues",
  "refactor-files",
  "codebase-explain",
  "pr-review-sweep",
  "parallel-test-fix",
];

describe("ashlr-spawn.md: file existence", () => {
  test("file exists and is non-empty", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content.length).toBeGreaterThan(0);
  });

  test("has YAML frontmatter with name field", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("name: ashlr-spawn");
  });
});

describe("ashlr-spawn.md: pattern references", () => {
  for (const pattern of REQUIRED_PATTERNS) {
    test(`mentions pattern: ${pattern}`, async () => {
      const content = await readCommand("ashlr-spawn");
      expect(content).toContain(pattern);
    });
  }
});

describe("ashlr-spawn.md: implementation details", () => {
  test("references _spawn-patterns.json", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("_spawn-patterns.json");
  });

  test("documents argument convention with pattern name", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("<pattern>");
  });

  test("documents args positional argument", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("args");
  });

  test("documents fanout strategies", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("fanout_strategy");
  });

  test("documents batch fanout strategy", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("batch");
  });

  test("documents parallel-per-file fanout strategy", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("parallel-per-file");
  });

  test("documents tiered fanout strategy", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("tiered");
  });

  test("references subagent_type", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("subagent_type");
  });

  test("has usage examples section", async () => {
    const content = await readCommand("ashlr-spawn");
    expect(content).toContain("/ashlr-spawn");
  });
});
