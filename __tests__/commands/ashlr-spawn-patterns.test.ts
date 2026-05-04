/**
 * Verifies that _spawn-patterns.json loads correctly and has the required shape.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "../../commands");

const REQUIRED_PATTERNS = [
  "triage-issues",
  "refactor-files",
  "codebase-explain",
  "pr-review-sweep",
  "parallel-test-fix",
] as const;

const VALID_SUBAGENT_TYPES = new Set([
  "ashlr:ashlr:explore",
  "ashlr:ashlr:code",
  "ashlr:ashlr:plan",
]);

const VALID_MODELS = new Set(["haiku", "sonnet", "opus"]);

const VALID_FANOUT_STRATEGIES = new Set([
  "batch",
  "parallel-per-file",
  "tiered",
  "parallel-per-file-changed",
]);

interface PatternEntry {
  subagent_type: string;
  model: string;
  prompt_template: string;
  fanout_strategy: string;
}

type PatternsFile = Record<string, PatternEntry>;

async function loadPatterns(): Promise<PatternsFile> {
  const raw = await readFile(join(commandsDir, "_spawn-patterns.json"), "utf8");
  return JSON.parse(raw) as PatternsFile;
}

describe("_spawn-patterns.json: file integrity", () => {
  test("file exists and is valid JSON", async () => {
    const raw = await readFile(join(commandsDir, "_spawn-patterns.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("has exactly 5 patterns", async () => {
    const patterns = await loadPatterns();
    expect(Object.keys(patterns)).toHaveLength(5);
  });

  test("contains all required pattern names", async () => {
    const patterns = await loadPatterns();
    for (const name of REQUIRED_PATTERNS) {
      expect(patterns).toHaveProperty(name);
    }
  });
});

describe("_spawn-patterns.json: shape validation", () => {
  for (const name of REQUIRED_PATTERNS) {
    describe(`pattern: ${name}`, () => {
      test("has subagent_type field", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(p).toBeDefined();
        expect(typeof p!.subagent_type).toBe("string");
        expect(p!.subagent_type.length).toBeGreaterThan(0);
      });

      test("subagent_type is a valid value", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(VALID_SUBAGENT_TYPES.has(p!.subagent_type as never)).toBe(true);
      });

      test("has model field", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(typeof p!.model).toBe("string");
        expect(p!.model.length).toBeGreaterThan(0);
      });

      test("model is a valid value", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(VALID_MODELS.has(p!.model as never)).toBe(true);
      });

      test("has prompt_template field", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(typeof p!.prompt_template).toBe("string");
        expect(p!.prompt_template.length).toBeGreaterThan(0);
      });

      test("has fanout_strategy field", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(typeof p!.fanout_strategy).toBe("string");
        expect(p!.fanout_strategy.length).toBeGreaterThan(0);
      });

      test("fanout_strategy is a valid value", async () => {
        const patterns = await loadPatterns();
        const p = patterns[name];
        expect(VALID_FANOUT_STRATEGIES.has(p!.fanout_strategy as never)).toBe(true);
      });
    });
  }
});

describe("_spawn-patterns.json: model/subagent assignments", () => {
  test("triage-issues uses haiku + explore", async () => {
    const patterns = await loadPatterns();
    const p = patterns["triage-issues"];
    expect(p!.model).toBe("haiku");
    expect(p!.subagent_type).toBe("ashlr:ashlr:explore");
  });

  test("refactor-files uses sonnet + code", async () => {
    const patterns = await loadPatterns();
    const p = patterns["refactor-files"];
    expect(p!.model).toBe("sonnet");
    expect(p!.subagent_type).toBe("ashlr:ashlr:code");
  });

  test("codebase-explain uses haiku + explore", async () => {
    const patterns = await loadPatterns();
    const p = patterns["codebase-explain"];
    expect(p!.model).toBe("haiku");
    expect(p!.subagent_type).toBe("ashlr:ashlr:explore");
  });

  test("pr-review-sweep uses sonnet + code", async () => {
    const patterns = await loadPatterns();
    const p = patterns["pr-review-sweep"];
    expect(p!.model).toBe("sonnet");
    expect(p!.subagent_type).toBe("ashlr:ashlr:code");
  });

  test("parallel-test-fix uses sonnet + code", async () => {
    const patterns = await loadPatterns();
    const p = patterns["parallel-test-fix"];
    expect(p!.model).toBe("sonnet");
    expect(p!.subagent_type).toBe("ashlr:ashlr:code");
  });
});

describe("_spawn-patterns.json: fanout strategies", () => {
  test("triage-issues uses batch fanout", async () => {
    const patterns = await loadPatterns();
    expect(patterns["triage-issues"]!.fanout_strategy).toBe("batch");
  });

  test("refactor-files uses parallel-per-file fanout", async () => {
    const patterns = await loadPatterns();
    expect(patterns["refactor-files"]!.fanout_strategy).toBe("parallel-per-file");
  });

  test("codebase-explain uses tiered fanout", async () => {
    const patterns = await loadPatterns();
    expect(patterns["codebase-explain"]!.fanout_strategy).toBe("tiered");
  });

  test("pr-review-sweep uses parallel-per-file-changed fanout", async () => {
    const patterns = await loadPatterns();
    expect(patterns["pr-review-sweep"]!.fanout_strategy).toBe("parallel-per-file-changed");
  });

  test("parallel-test-fix uses parallel-per-file fanout", async () => {
    const patterns = await loadPatterns();
    expect(patterns["parallel-test-fix"]!.fanout_strategy).toBe("parallel-per-file");
  });
});

describe("_spawn-patterns.json: prompt templates", () => {
  test("refactor-files template contains {{args}} and {{files}} placeholders", async () => {
    const patterns = await loadPatterns();
    const t = patterns["refactor-files"]!.prompt_template;
    expect(t).toContain("{{args}}");
    expect(t).toContain("{{files}}");
  });

  test("triage-issues template contains {{args}} placeholder", async () => {
    const patterns = await loadPatterns();
    const t = patterns["triage-issues"]!.prompt_template;
    expect(t).toContain("{{args}}");
  });

  test("codebase-explain template contains {{args}} placeholder", async () => {
    const patterns = await loadPatterns();
    const t = patterns["codebase-explain"]!.prompt_template;
    expect(t).toContain("{{args}}");
  });
});
