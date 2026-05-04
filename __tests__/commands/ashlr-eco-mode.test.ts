/**
 * Verifies ashlr-eco-mode.md content and on/off/status modes.
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

describe("ashlr-eco-mode.md: file existence", () => {
  test("file exists and is non-empty", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content.length).toBeGreaterThan(0);
  });

  test("has YAML frontmatter with name field", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("name: ashlr-eco-mode");
  });
});

describe("ashlr-eco-mode.md: usage modes", () => {
  test("documents on mode", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("on");
  });

  test("documents off mode", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("off");
  });

  test("documents status mode", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("status");
  });
});

describe("ashlr-eco-mode.md: env var", () => {
  test("documents ASHLR_ECO env var", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("ASHLR_ECO");
  });

  test("documents ASHLR_ECO=1 value", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("ASHLR_ECO=1");
  });
});

describe("ashlr-eco-mode.md: eco behaviors", () => {
  test("documents auto-compact behavior", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toMatch(/auto.compact|compact.*15/i);
  });

  test("documents genome grep enforcement", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toMatch(/genome.grep|genome.*grep/i);
  });

  test("documents lower summarization threshold", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("12288");
  });

  test("documents original summarization threshold for comparison", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("16384");
  });

  test("documents smart Task routing behavior", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toMatch(/Task.*routing|route.*Task|ashlr:ashlr:explore/i);
  });

  test("documents image attachment suppression", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toMatch(/image.*suppress|suppress.*image/i);
  });

  test("references pretooluse-eco-router hook", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toContain("pretooluse-eco-router");
  });
});

describe("ashlr-eco-mode.md: question-word routing", () => {
  test("documents question-shaped prompt routing", async () => {
    const content = await readCommand("ashlr-eco-mode");
    expect(content).toMatch(/what|where|how|explain|why/i);
  });
});
