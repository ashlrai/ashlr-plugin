import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveActiveLevel, buildAdditionalContext } from "../hooks/sessionstart-brief.ts";
import { detectToggle } from "../hooks/userpromptsubmit-brief-trigger.ts";
import { runCannedEval } from "../scripts/brief-eval.ts";

describe("ashlr-brief: SessionStart resolveActiveLevel", () => {
  let homeDir: string;
  let cwd: string;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "ashlr-brief-home-"));
    cwd = mkdtempSync(join(tmpdir(), "ashlr-brief-cwd-"));
    // Make cwd look like a repo so findRepoRoot finds it.
    writeFileSync(join(cwd, "package.json"), "{}");
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.ASHLR_ECO;
  });

  test("returns off when no config exists", () => {
    const r = resolveActiveLevel({ homeDir, cwd });
    expect(r.level).toBe("off");
    expect(r.source).toBe("none");
  });

  test("reads user-level config when present", () => {
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(join(homeDir, ".ashlr", "brief.json"), JSON.stringify({ level: "standard" }));
    const r = resolveActiveLevel({ homeDir, cwd });
    expect(r.level).toBe("standard");
    expect(r.source).toBe("user");
  });

  test("project-level overrides user-level", () => {
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(join(homeDir, ".ashlr", "brief.json"), JSON.stringify({ level: "lite" }));
    mkdirSync(join(cwd, ".ashlr"), { recursive: true });
    writeFileSync(join(cwd, ".ashlr", "brief.json"), JSON.stringify({ level: "concise" }));
    const r = resolveActiveLevel({ homeDir, cwd });
    expect(r.level).toBe("concise");
    expect(r.source).toBe("project");
  });

  test("user-level off with no project file → off", () => {
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(join(homeDir, ".ashlr", "brief.json"), JSON.stringify({ level: "off" }));
    const r = resolveActiveLevel({ homeDir, cwd });
    expect(r.level).toBe("off");
    expect(r.source).toBe("none");
  });

  test("ASHLR_ECO=1 with no config defaults to standard", () => {
    process.env.ASHLR_ECO = "1";
    const r = resolveActiveLevel({ homeDir, cwd });
    expect(r.level).toBe("standard");
    expect(r.source).toBe("user");
  });

  test("ASHLR_ECO=1 does not override an explicit user setting", () => {
    process.env.ASHLR_ECO = "1";
    mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
    writeFileSync(join(homeDir, ".ashlr", "brief.json"), JSON.stringify({ level: "concise" }));
    const r = resolveActiveLevel({ homeDir, cwd });
    expect(r.level).toBe("concise");
  });
});

describe("ashlr-brief: buildAdditionalContext", () => {
  test("emits empty string for off", () => {
    expect(buildAdditionalContext("off", "none")).toBe("");
  });

  test("includes the level marker", () => {
    expect(buildAdditionalContext("standard", "user")).toContain("[ashlr-brief: standard]");
    expect(buildAdditionalContext("concise", "user")).toContain("[ashlr-brief: concise]");
    expect(buildAdditionalContext("lite", "user")).toContain("[ashlr-brief: lite]");
  });

  test("includes auto-clarity exceptions", () => {
    const ctx = buildAdditionalContext("concise", "user");
    expect(ctx).toContain("destructive");
    expect(ctx).toContain("security");
    expect(ctx).toContain("error messages");
    expect(ctx).toContain("code blocks");
  });

  test("indicates source", () => {
    expect(buildAdditionalContext("standard", "project")).toContain("project-level");
    expect(buildAdditionalContext("standard", "user")).toContain("user-level");
  });
});

describe("ashlr-brief: detectToggle", () => {
  test("activates on 'be brief'", () => {
    expect(detectToggle("hey can you be brief about this")).toEqual({ level: "standard", reason: expect.any(String) });
  });

  test("activates on 'tldr' as concise", () => {
    expect(detectToggle("tldr what does this do")).toMatchObject({ level: "concise" });
  });

  test("deactivates on 'stop being brief'", () => {
    expect(detectToggle("ok stop being brief now")).toMatchObject({ level: "off" });
  });

  test("deactivates on 'normal mode'", () => {
    expect(detectToggle("switch to normal mode please")).toMatchObject({ level: "off" });
  });

  test("respects explicit level: 'brief on lite'", () => {
    expect(detectToggle("/brief on lite")).toMatchObject({ level: "lite" });
  });

  test("respects explicit level: 'brief = concise'", () => {
    expect(detectToggle("brief = concise")).toMatchObject({ level: "concise" });
  });

  test("returns null when no trigger phrase", () => {
    expect(detectToggle("just a regular question about the code")).toBe(null);
  });

  test("OFF beats ON when both phrases appear", () => {
    expect(detectToggle("be brief but actually stop being brief")).toMatchObject({ level: "off" });
  });
});

describe("ashlr-brief: brief-eval canned reductions", () => {
  test("standard hits ≥30% reduction", () => {
    const r = runCannedEval("standard");
    expect(r.reductionVsVerbose.brief).toBeGreaterThanOrEqual(0.30);
    expect(r.correctnessAllOk).toBe(true);
  });

  test("concise hits ≥45% reduction", () => {
    const r = runCannedEval("concise");
    expect(r.reductionVsVerbose.brief).toBeGreaterThanOrEqual(0.45);
    expect(r.correctnessAllOk).toBe(true);
  });

  test("lite hits ≥20% reduction", () => {
    const r = runCannedEval("lite");
    expect(r.reductionVsVerbose.brief).toBeGreaterThanOrEqual(0.20);
    expect(r.correctnessAllOk).toBe(true);
  });

  test("brief reduces more than generic 'be terse' control", () => {
    const r = runCannedEval("standard");
    // brief should be at least as compact as a naive "be terse" instruction
    expect(r.briefReductionVsControl).toBeGreaterThanOrEqual(0);
  });
});
