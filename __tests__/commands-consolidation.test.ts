/**
 * Verifies that retired/aliased command .md files contain deprecation notices
 * and references to their replacement commands. Ensures nothing was accidentally
 * deleted and that deprecation messaging is consistent across all 6 affected files.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "../commands");

async function readCommand(name: string): Promise<string> {
  return readFile(join(commandsDir, `${name}.md`), "utf8");
}

describe("commands-consolidation: aliased commands", () => {
  test("ashlr-context-status contains Deprecated notice and replacement", async () => {
    const content = await readCommand("ashlr-context-status");
    expect(content).toContain("Deprecated");
    expect(content).toContain("/ashlr-status --context");
    expect(content).toContain("name: ashlr-context-status");
  });

  test("ashlr-usage contains Deprecated notice and replacement", async () => {
    const content = await readCommand("ashlr-usage");
    expect(content).toContain("Deprecated");
    expect(content).toContain("/ashlr-dashboard --by-tool");
    expect(content).toContain("name: ashlr-usage");
  });

  test("ashlr-errors contains Deprecated notice and replacement", async () => {
    const content = await readCommand("ashlr-errors");
    expect(content).toContain("Deprecated");
    expect(content).toContain("/ashlr-doctor --errors");
    expect(content).toContain("name: ashlr-errors");
  });
});

describe("commands-consolidation: retired commands", () => {
  test("ashlr-recall contains Deprecated notice and retirement message", async () => {
    const content = await readCommand("ashlr-recall");
    expect(content).toContain("Deprecated");
    expect(content).toContain("ashlr-recall is retired");
    expect(content).toContain("memory system");
    expect(content).toContain("name: ashlr-recall");
  });

  test("ashlr-handoff contains Deprecated notice and moved message", async () => {
    const content = await readCommand("ashlr-handoff");
    expect(content).toContain("Deprecated");
    expect(content).toContain("ashlr-handoff has moved");
    expect(content).toContain("v1.15");
    expect(content).toContain("name: ashlr-handoff");
  });

  test("ashlr-coach contains Deprecated notice and retirement message", async () => {
    const content = await readCommand("ashlr-coach");
    expect(content).toContain("Deprecated");
    expect(content).toContain("ashlr-coach is retired");
    expect(content).toContain("/ashlr-legend");
    expect(content).toContain("name: ashlr-coach");
  });
});

describe("commands-consolidation: primary commands extended", () => {
  test("ashlr-status includes --context flag handling", async () => {
    const content = await readCommand("ashlr-status");
    expect(content).toContain("--context");
    expect(content).toContain("context-status.ts");
    expect(content).toContain("Embedding cache");
  });

  test("ashlr-dashboard includes --by-tool flag handling", async () => {
    const content = await readCommand("ashlr-dashboard");
    expect(content).toContain("--by-tool");
    expect(content).toContain("session-log-report.ts");
    expect(content).toContain("By tool");
  });

  test("ashlr-doctor includes --errors flag handling", async () => {
    const content = await readCommand("ashlr-doctor");
    expect(content).toContain("--errors");
    expect(content).toContain("errors-report.ts");
    expect(content).toContain("Recent errors");
  });
});

describe("commands-consolidation: no files deleted", () => {
  const allAffected = [
    "ashlr-context-status",
    "ashlr-usage",
    "ashlr-errors",
    "ashlr-recall",
    "ashlr-handoff",
    "ashlr-coach",
    "ashlr-status",
    "ashlr-dashboard",
    "ashlr-doctor",
  ];

  for (const name of allAffected) {
    test(`${name}.md still exists`, async () => {
      const content = await readCommand(name);
      expect(content.length).toBeGreaterThan(0);
    });
  }
});
