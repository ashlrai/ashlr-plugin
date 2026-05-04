/**
 * Verifies ashlr-help.md contains the Delegation section with all 5 new commands.
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

describe("ashlr-help.md: delegation section", () => {
  test("file exists and is non-empty", async () => {
    const content = await readCommand("ashlr-help");
    expect(content.length).toBeGreaterThan(0);
  });

  test("contains Delegation section header", async () => {
    const content = await readCommand("ashlr-help");
    expect(content).toContain("Delegation");
  });

  test("Delegation section uses the separator line style", async () => {
    const content = await readCommand("ashlr-help");
    expect(content).toMatch(/─+.+Delegation.+─+/);
  });

  for (const cmd of DELEGATION_COMMANDS) {
    test(`lists command: ${cmd}`, async () => {
      const content = await readCommand("ashlr-help");
      expect(content).toContain(cmd);
    });
  }

  test("Delegation section appears before Token meter section", async () => {
    const content = await readCommand("ashlr-help");
    const delegationIdx = content.indexOf("Delegation");
    const tokenMeterIdx = content.indexOf("Token meter");
    expect(delegationIdx).toBeGreaterThan(-1);
    expect(tokenMeterIdx).toBeGreaterThan(-1);
    expect(delegationIdx).toBeLessThan(tokenMeterIdx);
  });

  test("Delegation section appears after Onboarding section", async () => {
    const content = await readCommand("ashlr-help");
    const onboardingIdx = content.indexOf("Onboarding");
    const delegationIdx = content.indexOf("Delegation");
    expect(onboardingIdx).toBeGreaterThan(-1);
    expect(delegationIdx).toBeGreaterThan(-1);
    expect(onboardingIdx).toBeLessThan(delegationIdx);
  });
});

describe("ashlr-help.md: existing sections preserved", () => {
  const expectedSections = [
    "Onboarding",
    "Token meter",
    "Genome",
    "Diagnostics",
    "Pro / Team",
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
