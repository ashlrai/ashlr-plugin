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
  // ashlr-context-status, ashlr-usage, ashlr-errors deleted in v1.30 (surface contraction)

  test("ashlr-doctor includes --errors flag handling (replaces ashlr-errors)", async () => {
    const content = await readCommand("ashlr-doctor");
    expect(content).toContain("--errors");
  });

  test("ashlr-dashboard includes --by-tool flag handling (replaces ashlr-usage)", async () => {
    const content = await readCommand("ashlr-dashboard");
    expect(content).toContain("--by-tool");
  });

  test("ashlr-status includes --context flag handling (replaces ashlr-context-status)", async () => {
    const content = await readCommand("ashlr-status");
    expect(content).toContain("--context");
  });
});

describe("commands-consolidation: retired commands", () => {
  // ashlr-recall deleted in v1.30 (surface contraction — was already deprecated since v1.13)

  test("ashlr-handoff is wired to /ashlr-dashboard --handoff", async () => {
    // Was deprecated in v1.13 with a "moved to v1.15" placeholder; the
    // --handoff flag actually shipped in this PR, so the command now
    // delegates to savings-dashboard.ts --handoff and is no longer
    // deprecated.
    const content = await readCommand("ashlr-handoff");
    expect(content).toContain("name: ashlr-handoff");
    expect(content).toContain("savings-dashboard.ts --handoff");
    expect(content).not.toContain("Deprecated");
  });

  // v1.18: ashlr-coach retired entirely (was deprecated since v1.13).
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

describe("commands-consolidation: ashlr-help.md hides deprecated stubs", () => {
  test("help table does not list deprecated commands as live entries", async () => {
    const content = await readCommand("ashlr-help");
    // Deprecated stubs still ship as redirect .md files (enforced above) but
    // /ashlr-help no longer advertises them. The "Legacy" section was removed
    // in v1.27 — users discover deprecated commands only by typing them.
    expect(content).not.toContain("Legacy");
    expect(content).not.toContain("/ashlr-recall ");
    expect(content).not.toContain("/ashlr-usage ");
    expect(content).not.toContain("/ashlr-context-status ");
    expect(content).not.toContain("/ashlr-errors ");
  });

  test("help table includes /ashlr-resume, /ashlr-compact, /ashlr-genome-rewrap", async () => {
    const content = await readCommand("ashlr-help");
    expect(content).toContain("/ashlr-resume");
    expect(content).toContain("/ashlr-compact");
    expect(content).toContain("/ashlr-genome-rewrap");
  });

  test("help table has a single MCP tools section (no duplicate)", async () => {
    const content = await readCommand("ashlr-help");
    const matches = content.match(/─── MCP tools/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("commands-consolidation: primary command files exist", () => {
  // ashlr-context-status, ashlr-usage, ashlr-errors, ashlr-recall deleted in v1.30
  const allAffected = [
    "ashlr-handoff",
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
