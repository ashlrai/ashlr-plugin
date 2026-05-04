/**
 * Verifies ashlr-budget.md content and env var documentation.
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

describe("ashlr-budget.md: file existence", () => {
  test("file exists and is non-empty", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content.length).toBeGreaterThan(0);
  });

  test("has YAML frontmatter with name field", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("name: ashlr-budget");
  });
});

describe("ashlr-budget.md: usage modes", () => {
  test("documents $X dollar cap mode", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("$X");
  });

  test("documents tokens=N token cap mode", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("tokens=");
  });

  test("documents status mode", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("status");
  });

  test("documents off mode", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("off");
  });
});

describe("ashlr-budget.md: env vars", () => {
  test("documents ASHLR_SESSION_BUDGET_USD", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("ASHLR_SESSION_BUDGET_USD");
  });

  test("documents ASHLR_SESSION_BUDGET_TOKENS", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("ASHLR_SESSION_BUDGET_TOKENS");
  });

  test("notes mutual exclusivity of USD and tokens cap", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("mutually exclusive");
  });
});

describe("ashlr-budget.md: guard behavior", () => {
  test("documents 80% warning threshold", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("80%");
  });

  test("documents 95% warning threshold", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("95%");
  });

  test("documents 100% block behavior", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("100%");
  });

  test("references pretooluse-budget-guard hook", async () => {
    const content = await readCommand("ashlr-budget");
    expect(content).toContain("pretooluse-budget-guard");
  });
});

describe("ashlr-budget.md: status line", () => {
  test("documents status line segment format", async () => {
    const content = await readCommand("ashlr-budget");
    // Should mention some form of the status line display
    expect(content).toMatch(/status.line|\$X.*\$Y|segment/i);
  });
});
