/**
 * orchestrate-e2e.smoke.test.ts — Q1'27 end-to-end smoke test for the
 * distributed-orchestration MVP.
 *
 * Exercises the full pipeline (expand → render → confirm → run) by spawning
 * real `bun scripts/cli-orchestrate.ts` subprocesses. Goal: catch integration
 * drift across Track A (schema + expander), Track B (renderer + runner), and
 * Track C (CLI) before any of the three rots in isolation.
 *
 * Why a separate file from cli-orchestrate.smoke.test.ts? That test exercises
 * one happy-path invocation against `./servers`. This one walks the matrix:
 * tier gates, node caps, YAML override, invalid YAML, cancel input, sequential
 * ordering, dry-run isolation.
 *
 * Constraints:
 *   - No new external deps. Uses Bun.spawn + Node's child_process.
 *   - ASHLR_ORCHESTRATE_REAL_LLM is intentionally UNSET — the stub path runs.
 *   - Each subprocess invocation is capped at 30s wallclock.
 *   - Total wall time target: <30s.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_PATH = join(REPO_ROOT, "scripts", "cli-orchestrate.ts");
const TINY_FIXTURE = join(REPO_ROOT, "__tests__", "fixtures", "orchestrate-tiny");
const FIVE_FIXTURE = join(REPO_ROOT, "__tests__", "fixtures", "orchestrate-five-modules");
const TMP_DIR = join(tmpdir(), `orchestrate-e2e-${process.pid}`);

const SUBPROCESS_TIMEOUT_MS = 30_000;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  // Build a clean env. Strip ASHLR_ORCHESTRATE_REAL_LLM to guarantee the stub
  // runner path is exercised, never the real-LLM path that future PRs add.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(opts.env ?? {}),
  };
  delete env["ASHLR_ORCHESTRATE_REAL_LLM"];

  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdin !== undefined && proc.stdin) {
    const writer = proc.stdin as unknown as { write: (s: string) => void; end: () => void };
    writer.write(opts.stdin);
    writer.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* best-effort */
    }
  }, SUBPROCESS_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";
  try {
    const stdoutPromise =
      proc.stdout instanceof ReadableStream
        ? new Response(proc.stdout).text()
        : Promise.resolve("");
    const stderrPromise =
      proc.stderr instanceof ReadableStream
        ? new Response(proc.stderr).text()
        : Promise.resolve("");
    stdout = await stdoutPromise;
    stderr = await stderrPromise;
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const exitCode = typeof proc.exitCode === "number" ? proc.exitCode : -1;
  return { exitCode, stdout, stderr, timedOut };
}

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

const FIVE_MODULES = ["alpha", "bravo", "charlie", "delta", "echo"];

function ensureFiveModuleFixture(): void {
  // The fixture is committed alongside this test, but we self-heal if a
  // teammate deletes it or runs the suite from a partial checkout.
  if (existsSync(FIVE_FIXTURE)) return;
  mkdirSync(FIVE_FIXTURE, { recursive: true });
  for (const m of FIVE_MODULES) {
    const dir = join(FIVE_FIXTURE, m);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file.ts"), `export const name = "${m}";\n`, "utf-8");
  }
}

beforeAll(() => {
  ensureFiveModuleFixture();
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  // Tmp YAML scratch files only — never touch the fixtures, they may be
  // tracked.
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orchestrate e2e smoke", () => {
  test("1. free tier blocks with upgrade message", async () => {
    const r = await runCli(
      ["x", "--scope", TINY_FIXTURE, "--auto-confirm", "--dry-run"],
      { env: { ASHLR_TEST_TIER: "free" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(1);
    const combined = (r.stdout + r.stderr).toLowerCase();
    // Track C's free-tier message: "Orchestration requires Pro or Team. Run /ashlr-upgrade."
    const mentionsUpgrade =
      combined.includes("pro") ||
      combined.includes("team") ||
      combined.includes("upgrade");
    expect(mentionsUpgrade).toBe(true);
    // No graph should have been rendered.
    expect(r.stdout).not.toContain("Orchestration plan");
    expect(/\bnode-\S+/.test(r.stdout)).toBe(false);
  });

  test("2. pro tier auto-expand dry-run on tiny fixture", async () => {
    const r = await runCli(
      [
        "refactor auth",
        "--scope",
        TINY_FIXTURE,
        "--auto-confirm",
        "--dry-run",
      ],
      { env: { ASHLR_TEST_TIER: "pro" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    // Goal echoed.
    expect(r.stdout).toContain("refactor auth");
    // At least one node id.
    expect(/\bnode-\S+/.test(r.stdout)).toBe(true);
    // Success marker.
    expect(r.stdout).toContain("completed");
    // Token budget number — Track B's renderer formats with locale commas
    // (e.g. "6,500 token budget") so we just assert the budget label + digits.
    expect(/token budget/.test(r.stdout)).toBe(true);
    expect(/~[\d,]+ token budget/.test(r.stdout)).toBe(true);
  });

  test("3. pro tier respects 3-node cap on 5-module fixture", async () => {
    const r = await runCli(
      [
        "do work",
        "--scope",
        FIVE_FIXTURE,
        "--tier",
        "pro",
        "--auto-confirm",
        "--dry-run",
      ],
      { env: { ASHLR_TEST_TIER: "pro" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    // Renderer header: "tier: pro · 3 nodes · ..."
    const nodesHeader = r.stdout.match(/tier:\s*pro\s*·\s*(\d+)\s*nodes?/);
    expect(nodesHeader).not.toBeNull();
    const nodeCount = Number(nodesHeader![1]);
    expect(nodeCount).toBeLessThanOrEqual(3);
    expect(nodeCount).toBeGreaterThan(0);
    // Cross-check: count distinct [N] node ordinal markers.
    const ordinals = Array.from(r.stdout.matchAll(/^\[(\d+)\]\s+node-/gm)).map(
      (m) => Number(m[1]),
    );
    expect(ordinals.length).toBeLessThanOrEqual(3);
  });

  test("4. team tier expands to all 5 nodes on 5-module fixture", async () => {
    const r = await runCli(
      [
        "do work",
        "--scope",
        FIVE_FIXTURE,
        "--tier",
        "team",
        "--auto-confirm",
        "--dry-run",
      ],
      { env: { ASHLR_TEST_TIER: "team" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const nodesHeader = r.stdout.match(/tier:\s*team\s*·\s*(\d+)\s*nodes?/);
    expect(nodesHeader).not.toBeNull();
    const nodeCount = Number(nodesHeader![1]);
    // Team cap is 10; we have 5 modules so we expect exactly 5.
    expect(nodeCount).toBe(5);
    // Each of the five module names should surface as a node id.
    for (const m of FIVE_MODULES) {
      expect(r.stdout).toContain(`node-${m}`);
    }
  });

  test("5. --yaml override loads hand-crafted graph (not auto-expanded)", async () => {
    const yamlPath = join(TMP_DIR, "hand-crafted.yaml");
    // Carefully follow Track A's emit format (2-space indent, double-quoted
    // strings) so the minimal indent-driven parser accepts it.
    const yaml = [
      'id: "hand-crafted-graph-id"',
      'goal: "hand-crafted YAML graph"',
      'scope: "."',
      'tier: "pro"',
      'createdAt: "2026-05-22T00:00:00.000Z"',
      "nodes:",
      '  - id: "node-handA"',
      '    agentKind: "refactorer"',
      '    goal: "First hand-crafted step"',
      "    scope:",
      '      - "."',
      "    deps: []",
      "    estimatedTokens: 1000",
      '  - id: "node-handB"',
      '    agentKind: "refactorer"',
      '    goal: "Second hand-crafted step"',
      "    scope:",
      '      - "."',
      "    deps:",
      '      - "node-handA"',
      "    estimatedTokens: 1500",
      '  - id: "node-handC"',
      '    agentKind: "reviewer"',
      '    goal: "Third hand-crafted step"',
      "    scope:",
      '      - "."',
      "    deps:",
      '      - "node-handB"',
      "    estimatedTokens: 2000",
      "handoffs: []",
      "metadata:",
      "  autoExpanded: false",
      "  totalTokenBudget: 4500",
      "",
    ].join("\n");
    writeFileSync(yamlPath, yaml, "utf-8");

    const r = await runCli(
      ["--yaml", yamlPath, "--auto-confirm", "--dry-run"],
      { env: { ASHLR_TEST_TIER: "pro" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    // The hand-crafted node ids must appear verbatim — proves the YAML loader
    // ran instead of the expander (the expander would emit node-<module>
    // names from the cwd's children, NOT node-handA).
    expect(r.stdout).toContain("node-handA");
    expect(r.stdout).toContain("node-handB");
    expect(r.stdout).toContain("node-handC");
    // The hand-crafted goal must be echoed.
    expect(r.stdout).toContain("hand-crafted YAML graph");
  });

  test("6. invalid YAML rejected with a parse error", async () => {
    const yamlPath = join(TMP_DIR, "invalid.yaml");
    // Indent jumps from 0 to 2 then to 4 with malformed content — the
    // minimal parser bails on the unexpected indent.
    writeFileSync(
      yamlPath,
      "this is: not\n  proper:\n    yaml at all - { malformed\n",
      "utf-8",
    );

    const r = await runCli(
      ["--yaml", yamlPath, "--auto-confirm", "--dry-run"],
      { env: { ASHLR_TEST_TIER: "pro" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(1);
    const combined = (r.stdout + r.stderr).toLowerCase();
    const mentionsError =
      combined.includes("yaml parse error") ||
      combined.includes("yaml-parse") ||
      combined.includes("graph validation failed") ||
      combined.includes("validation");
    expect(mentionsError).toBe(true);
  });

  test("7. cancel path: 'n' on stdin exits 0 with cancelled marker", async () => {
    const r = await runCli(
      ["refactor", "--scope", TINY_FIXTURE, "--dry-run"],
      {
        env: { ASHLR_TEST_TIER: "pro" },
        // Feed a single "n\n" so the y/n/e prompt resolves to cancel.
        stdin: "n\n",
      },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("cancelled");
    // The render should still have printed (cancel happens AFTER preview).
    expect(r.stdout).toContain("Orchestration plan");
    // But the run summary must NOT have printed.
    expect(r.stdout).not.toContain("Run summary");
  });

  test("8. sequential ordering: nodes printed [1], [2], [3] in topo order", async () => {
    const yamlPath = join(TMP_DIR, "chain.yaml");
    const yaml = [
      'id: "chain-graph"',
      'goal: "A then B then C"',
      'scope: "."',
      'tier: "pro"',
      'createdAt: "2026-05-22T00:00:00.000Z"',
      "nodes:",
      '  - id: "node-A"',
      '    agentKind: "refactorer"',
      '    goal: "step A"',
      "    scope:",
      '      - "."',
      "    deps: []",
      "    estimatedTokens: 500",
      '  - id: "node-B"',
      '    agentKind: "refactorer"',
      '    goal: "step B"',
      "    scope:",
      '      - "."',
      "    deps:",
      '      - "node-A"',
      "    estimatedTokens: 500",
      '  - id: "node-C"',
      '    agentKind: "reviewer"',
      '    goal: "step C"',
      "    scope:",
      '      - "."',
      "    deps:",
      '      - "node-B"',
      "    estimatedTokens: 500",
      "handoffs: []",
      "metadata:",
      "  autoExpanded: false",
      "  totalTokenBudget: 1500",
      "",
    ].join("\n");
    writeFileSync(yamlPath, yaml, "utf-8");

    const r = await runCli(
      ["--yaml", yamlPath, "--auto-confirm", "--dry-run"],
      { env: { ASHLR_TEST_TIER: "pro" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    // Find the ordinal-prefixed lines and their associated node ids.
    const ordered = Array.from(
      r.stdout.matchAll(/^\[(\d+)\]\s+(node-[A-Za-z0-9_-]+)/gm),
    ).map((m) => ({ ord: Number(m[1]), id: m[2] }));
    expect(ordered.length).toBe(3);
    expect(ordered[0]).toEqual({ ord: 1, id: "node-A" });
    expect(ordered[1]).toEqual({ ord: 2, id: "node-B" });
    expect(ordered[2]).toEqual({ ord: 3, id: "node-C" });
  });

  test("9. --dry-run does NOT emit the real-run stub marker", async () => {
    const r = await runCli(
      [
        "refactor",
        "--scope",
        TINY_FIXTURE,
        "--auto-confirm",
        "--dry-run",
      ],
      { env: { ASHLR_TEST_TIER: "pro" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    // The runner only emits "STUB-NODE:" via the per-node subprocess on the
    // non-dry-run path. Dry-run replaces it with "[dry-run]" output that
    // never bubbles to the CLI's printed summary.
    expect(r.stdout).not.toContain("STUB-NODE:");
  });
});
