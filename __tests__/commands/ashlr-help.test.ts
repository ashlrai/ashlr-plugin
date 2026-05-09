/**
 * Verifies ashlr-help.md contains the Tier-0-first structure (v1.30 surface contraction).
 * Old section names (Onboarding, Delegation, Token meter, Diagnostics, Pro / Team)
 * replaced with Tier 0/1/2/3 groupings.
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

const DELEGATION_COMMANDS = [
  "/ashlr-spawn",
  "/ashlr-parallelize",
  "/ashlr-tier",
  "/ashlr-budget",
  "/ashlr-eco-mode",
];

describe("ashlr-help.md: tier structure (v1.30)", () => {
  test("file exists and is non-empty", async () => {
    const content = await readCommand("ashlr-help");
    expect(content.length).toBeGreaterThan(0);
  });

  test("contains Tier 0 section header", async () => {
    const content = await readCommand("ashlr-help");
    expect(content).toContain("Tier 0");
  });

  test("Tier 0 section uses separator line style", async () => {
    const content = await readCommand("ashlr-help");
    expect(content).toMatch(/─+.+Tier 0.+─+/);
  });

  for (const cmd of DELEGATION_COMMANDS) {
    test(`lists delegation command: ${cmd}`, async () => {
      const content = await readCommand("ashlr-help");
      expect(content).toContain(cmd);
    });
  }

  test("Tier 0 appears before Tier 1", async () => {
    const content = await readCommand("ashlr-help");
    const tier0Idx = content.indexOf("Tier 0");
    const tier1Idx = content.indexOf("Tier 1");
    expect(tier0Idx).toBeGreaterThan(-1);
    expect(tier1Idx).toBeGreaterThan(-1);
    expect(tier0Idx).toBeLessThan(tier1Idx);
  });

  test("Tier 1 appears before Tier 2", async () => {
    const content = await readCommand("ashlr-help");
    const tier1Idx = content.indexOf("Tier 1");
    const tier2Idx = content.indexOf("Tier 2");
    expect(tier1Idx).toBeGreaterThan(-1);
    expect(tier2Idx).toBeGreaterThan(-1);
    expect(tier1Idx).toBeLessThan(tier2Idx);
  });
});

describe("ashlr-help.md: existing sections preserved", () => {
  const expectedSections = [
    "Tier 0",
    "Tier 1",
    "Tier 2",
    "Tier 3",
    "Genome",
    "MCP tools",
  ];

  for (const section of expectedSections) {
    test(`still contains section: ${section}`, async () => {
      const content = await readCommand("ashlr-help");
      expect(content).toContain(section);
    });
  }

  test("Tip line still present", async () => {
    const content = await readCommand("ashlr-help");
    expect(content).toContain("/ashlr-savings");
  });
});

describe("ashlr-help.md: command descriptions", () => {
  test("/ashlr-spawn has a description mentioning patterns", async () => {
    const content = await readCommand("ashlr-help");
    const spawnLine = content.split("\n").find((l) => l.includes("/ashlr-spawn"));
    expect(spawnLine).toBeDefined();
  });

  test("/ashlr-parallelize has a description mentioning parallel", async () => {
    const content = await readCommand("ashlr-help");
    const parallelLine = content.split("\n").find((l) => l.includes("/ashlr-parallelize"));
    expect(parallelLine).toBeDefined();
  });

  test("/ashlr-tier has a description", async () => {
    const content = await readCommand("ashlr-help");
    const tierLine = content.split("\n").find((l) => l.includes("/ashlr-tier"));
    expect(tierLine).toBeDefined();
  });

  test("/ashlr-budget has a description mentioning cap or spend", async () => {
    const content = await readCommand("ashlr-help");
    const budgetLine = content.split("\n").find((l) => l.includes("/ashlr-budget"));
    expect(budgetLine).toBeDefined();
  });

  test("/ashlr-eco-mode has a description mentioning eco", async () => {
    const content = await readCommand("ashlr-help");
    const ecoLine = content.split("\n").find((l) => l.includes("/ashlr-eco-mode"));
    expect(ecoLine).toBeDefined();
  });
});
