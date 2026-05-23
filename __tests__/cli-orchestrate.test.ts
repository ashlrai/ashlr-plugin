/**
 * Unit tests for scripts/cli-orchestrate.ts — Q1 '27 distributed orchestration
 * MVP (Track C: slash command + integration glue).
 *
 * Coverage matrix:
 *   1. Free tier → exits 1 with helpful message, no expand call.
 *   2. Pro tier auto-expand path → invokes expand, prints render output.
 *   3. --yaml <bad-path> → exit 1 with validation errors.
 *   4. --auto-confirm skips the y/n prompt.
 *   5. --dry-run flag is propagated to the runner.
 *   6. "n" cancellation → exit 0 + "cancelled", no run.
 *   7. "e" edit path → writes YAML to tmp, prints path, no run.
 *   8. Happy path renders the per-node summary.
 *   9. parseArgs handles flags + positional goal.
 *  10. resolveTier honors ASHLR_TEST_TIER + arg override.
 *
 * Targets Track A's schema (deps + agentKind + estimatedTokens; TaskGraph
 * requires id/createdAt/handoffs/metadata; discriminated-union returns
 * from fromYaml + validateTaskGraph).
 *
 * Pattern: dependency injection — every external (isPro, expand, run,
 * stdin, fs) is overridden via the MainDeps struct. No real subprocesses,
 * no network, no real ~/.ashlr writes (tests redirect via deps.home).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  formatSummary,
  main,
  parseArgs,
  resolveTier,
} from "../scripts/cli-orchestrate";
import type { TaskGraph } from "../servers/_task-graph";
import { toYaml } from "../servers/_task-graph";
import type { RunResult } from "../scripts/orchestrate-run";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CaptureOutputs {
  out: string;
  err: string;
}

function captureFns() {
  const cap: CaptureOutputs = { out: "", err: "" };
  return {
    cap,
    stdout: (s: string) => {
      cap.out += s;
    },
    stderr: (s: string) => {
      cap.err += s;
    },
  };
}

function makeGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "g-test-0001",
    goal: "test goal",
    scope: "/tmp/work",
    tier: "pro",
    createdAt: "2027-01-01T00:00:00.000Z",
    nodes: [
      {
        id: "node-explore",
        agentKind: "generic",
        goal: "explore step",
        scope: ["./a"],
        deps: [],
        estimatedTokens: 1000,
      },
      {
        id: "node-implement",
        agentKind: "refactorer",
        goal: "implement step",
        scope: ["./a"],
        deps: ["node-explore"],
        estimatedTokens: 3000,
      },
      {
        id: "node-verify",
        agentKind: "test-writer",
        goal: "verify step",
        scope: ["./a"],
        deps: ["node-implement"],
        estimatedTokens: 1000,
      },
    ],
    handoffs: [],
    metadata: {
      autoExpanded: true,
      totalTokenBudget: 5000,
    },
    ...overrides,
  };
}

function okResult(): RunResult {
  return {
    ok: true,
    totalDurationMs: 100,
    totalTokens: 5000,
    nodes: [
      { id: "node-explore", ok: true, durationMs: 30, tokens: 1000 },
      { id: "node-implement", ok: true, durationMs: 50, tokens: 3000 },
      { id: "node-verify", ok: true, durationMs: 20, tokens: 1000 },
    ],
  };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ashlr-orchestrate-test-"));
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseArgs / resolveTier
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses goal + flags", () => {
    const a = parseArgs([
      "refactor",
      "auth",
      "--scope",
      "./src",
      "--auto-confirm",
    ]);
    expect(a.goal).toBe("refactor auth");
    expect(a.scope).toBe("./src");
    expect(a.autoConfirm).toBe(true);
    expect(a.dryRun).toBe(false);
  });

  test("handles --yaml + --dry-run + --tier overrides", () => {
    const a = parseArgs([
      "--yaml",
      "/tmp/g.yaml",
      "--dry-run",
      "--tier",
      "team",
    ]);
    expect(a.yamlPath).toBe("/tmp/g.yaml");
    expect(a.dryRun).toBe(true);
    expect(a.tierOverride).toBe("team");
    expect(a.goal).toBeNull();
  });
});

describe("resolveTier", () => {
  test("ASHLR_TEST_TIER overrides isProSync", () => {
    expect(
      resolveTier({ ASHLR_TEST_TIER: "team" } as NodeJS.ProcessEnv, () => false),
    ).toBe("team");
    expect(
      resolveTier({ ASHLR_TEST_TIER: "free" } as NodeJS.ProcessEnv, () => true),
    ).toBe("free");
  });
  test("arg override beats env + isPro", () => {
    expect(
      resolveTier(
        { ASHLR_TEST_TIER: "free" } as NodeJS.ProcessEnv,
        () => true,
        "team",
      ),
    ).toBe("team");
  });
  test("falls back to isProSync when no env / arg", () => {
    expect(resolveTier({} as NodeJS.ProcessEnv, () => true)).toBe("pro");
    expect(resolveTier({} as NodeJS.ProcessEnv, () => false)).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// 1. Free tier blocked
// ---------------------------------------------------------------------------

describe("free tier", () => {
  test("exits 1 with upgrade message, no expand call", async () => {
    let expandCalled = false;
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["build a thing"],
      env: { ASHLR_TEST_TIER: "free" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => {
        expandCalled = true;
        return makeGraph();
      },
      run: async () => okResult(),
    });
    expect(code).toBe(1);
    expect(expandCalled).toBe(false);
    expect(cap.err).toContain("Pro or Team");
    expect(cap.err).toContain("/ashlr-upgrade");
  });
});

// ---------------------------------------------------------------------------
// 2. Pro auto-expand path
// ---------------------------------------------------------------------------

describe("pro auto-expand", () => {
  test("calls expand and prints rendered output", async () => {
    const { cap, stdout, stderr } = captureFns();
    const expandArgs: { goal?: string; tier?: string | undefined } = {};
    const code = await main({
      argv: ["refactor the auth flow", "--auto-confirm", "--dry-run"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async (o) => {
        expandArgs.goal = o.goal;
        expandArgs.tier = o.tier;
        return makeGraph({ goal: o.goal });
      },
      run: async () => okResult(),
    });
    expect(code).toBe(0);
    expect(expandArgs.goal).toBe("refactor the auth flow");
    expect(expandArgs.tier).toBe("pro");
    expect(cap.out).toContain("Orchestration plan");
    expect(cap.out).toContain("refactor the auth flow");
    expect(cap.out).toContain("node-explore");
    expect(cap.out).toContain("Run summary");
  });
});

// ---------------------------------------------------------------------------
// 3. --yaml validation errors
// ---------------------------------------------------------------------------

describe("--yaml bad path", () => {
  test("missing file → exit 1 with read error", async () => {
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["--yaml", "/does/not/exist.yaml"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      readFile: () => {
        throw new Error("ENOENT");
      },
      run: async () => okResult(),
    });
    expect(code).toBe(1);
    expect(cap.err).toContain("Could not read YAML");
  });

  test("invalid YAML (totally empty / garbage) → exit 1 with parse error", async () => {
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["--yaml", "/tmp/bad.yaml"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      readFile: () => "",
      run: async () => okResult(),
    });
    expect(code).toBe(1);
    // Either YAML parse or validation rejects an empty doc.
    expect(cap.err.toLowerCase()).toMatch(/yaml|validation|missing/);
  });

  test("valid YAML loads and runs", async () => {
    const graph = makeGraph();
    const yamlText = toYaml(graph);
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["--yaml", "/tmp/g.yaml", "--auto-confirm"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      readFile: () => yamlText,
      run: async () => okResult(),
    });
    expect(code).toBe(0);
    expect(cap.out).toContain("Run summary");
  });
});

// ---------------------------------------------------------------------------
// 4. --auto-confirm skips prompt
// ---------------------------------------------------------------------------

describe("--auto-confirm", () => {
  test("does not call readLine", async () => {
    let readLineCalled = false;
    const { stdout, stderr } = captureFns();
    const code = await main({
      argv: ["do thing", "--auto-confirm"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => makeGraph(),
      run: async () => okResult(),
      readLine: async () => {
        readLineCalled = true;
        return "n";
      },
    });
    expect(code).toBe(0);
    expect(readLineCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. --dry-run propagation
// ---------------------------------------------------------------------------

describe("--dry-run", () => {
  test("flag reaches the runner", async () => {
    const captured: { dryRun?: boolean } = {};
    const { stdout, stderr } = captureFns();
    await main({
      argv: ["do thing", "--auto-confirm", "--dry-run"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => makeGraph(),
      run: async (o) => {
        captured.dryRun = o.dryRun;
        return okResult();
      },
    });
    expect(captured.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. "n" cancellation
// ---------------------------------------------------------------------------

describe("n cancellation", () => {
  test("exits 0 with cancelled message, runner never called", async () => {
    let runCalled = false;
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["do thing"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => makeGraph(),
      run: async () => {
        runCalled = true;
        return okResult();
      },
      readLine: async () => "n",
    });
    expect(code).toBe(0);
    expect(runCalled).toBe(false);
    expect(cap.out).toContain("cancelled");
  });
});

// ---------------------------------------------------------------------------
// 7. "e" edit path
// ---------------------------------------------------------------------------

describe("e edit path", () => {
  test("writes YAML to ~/.ashlr/orchestrate-edit-<id>.yaml, prints path, exits 0", async () => {
    let runCalled = false;
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["do thing"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => makeGraph(),
      run: async () => {
        runCalled = true;
        return okResult();
      },
      readLine: async () => "e",
      home: () => tmpHome,
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(code).toBe(0);
    expect(runCalled).toBe(false);
    expect(cap.out).toContain("orchestrate-edit-");
    expect(cap.out).toContain("Edit and re-run with --yaml");
    const written = cap.out.match(/orchestrate-edit-[^\s]+\.yaml/);
    expect(written).not.toBeNull();
    if (written) {
      const fullPath = join(tmpHome, ".ashlr", written[0]);
      expect(existsSync(fullPath)).toBe(true);
      const body = readFileSync(fullPath, "utf-8");
      expect(body).toContain("goal:");
      expect(body).toContain("test goal");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Happy path summary
// ---------------------------------------------------------------------------

describe("happy path", () => {
  test("renders the per-node summary", async () => {
    const { cap, stdout, stderr } = captureFns();
    const code = await main({
      argv: ["ship it", "--auto-confirm"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => makeGraph(),
      run: async () => okResult(),
    });
    expect(code).toBe(0);
    expect(cap.out).toContain("Run summary");
    expect(cap.out).toContain("[ok]  node-explore");
    expect(cap.out).toContain("[ok]  node-implement");
    expect(cap.out).toContain("[ok]  node-verify");
    expect(cap.out).toContain("completed");
  });

  test("failing node → exit 1", async () => {
    const { stdout, stderr } = captureFns();
    const code = await main({
      argv: ["ship it", "--auto-confirm"],
      env: { ASHLR_TEST_TIER: "pro" } as NodeJS.ProcessEnv,
      stdout,
      stderr,
      expand: async () => makeGraph(),
      run: async () => ({
        ok: false,
        totalDurationMs: 50,
        totalTokens: 1000,
        nodes: [
          {
            id: "node-explore",
            ok: false,
            durationMs: 50,
            tokens: 1000,
            error: "boom",
          },
        ],
      }),
    });
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

describe("formatSummary", () => {
  test("formats ok + failed nodes with error suffix", () => {
    const s = formatSummary({
      ok: false,
      totalDurationMs: 200,
      totalTokens: 1234,
      nodes: [
        { id: "node-explore", ok: true, durationMs: 50, tokens: 1000 },
        {
          id: "node-implement",
          ok: false,
          durationMs: 150,
          tokens: 234,
          error: "boom",
        },
      ],
    });
    expect(s).toContain("[ok]  node-explore");
    expect(s).toContain("[fail]node-implement");
    expect(s).toContain("boom");
    expect(s).toContain("completed");
  });
});
