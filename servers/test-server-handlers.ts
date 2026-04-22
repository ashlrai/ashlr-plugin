/**
 * test-server-handlers — side-effect module.
 *
 * Importing this file registers the ashlr__test tool into the shared registry
 * (_tool-base.ts). Used by both the standalone entry point (test-server.ts)
 * and the router (_router.ts via _router-handlers.ts).
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { clampToCwd } from "./_cwd-clamp";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import {
  parseJestLike,
  parsePytest,
  parseGoTest,
  parseGenericTap,
  type TestResult,
  type TestFailure,
} from "./_test-parsers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Runner = "auto" | "bun" | "vitest" | "jest" | "pytest" | "go";

interface TestOptions {
  command?: string;
  cwd?: string;
  files?: string[];
  runner?: Runner;
  failuresOnly?: boolean;
  bypassSummary?: boolean;
}

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

function detectRunner(cwd: string): Exclude<Runner, "auto"> {
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) return "pytest";
  if (existsSync(join(cwd, "package.json"))) {
    // Prefer bun if bun.lockb present
    if (existsSync(join(cwd, "bun.lockb"))) return "bun";
    // Check package.json scripts for vitest vs jest
    try {
      const pkg = JSON.parse(require("fs").readFileSync(join(cwd, "package.json"), "utf-8"));
      const scripts: Record<string, string> = pkg.scripts ?? {};
      const devDeps: Record<string, string> = { ...pkg.devDependencies, ...pkg.dependencies };
      if ("vitest" in devDeps || Object.values(scripts).some((s) => s.includes("vitest"))) return "vitest";
      if ("jest" in devDeps || Object.values(scripts).some((s) => s.includes("jest"))) return "jest";
    } catch {
      // fall through
    }
    return "bun";
  }
  return "bun"; // last resort
}

function buildCommand(runner: Exclude<Runner, "auto">, files: string[]): string[] {
  const fileArgs = files.length > 0 ? files : [];
  switch (runner) {
    case "bun":     return ["bun", "test", ...fileArgs];
    case "vitest":  return ["bunx", "vitest", "run", ...fileArgs];
    case "jest":    return ["bunx", "jest", "--no-coverage", ...fileArgs];
    case "pytest":  return ["python", "-m", "pytest", "--tb=short", "-q", ...fileArgs];
    case "go":      return ["go", "test", "-json", "./..."];
  }
}

// ---------------------------------------------------------------------------
// Parser dispatch
// ---------------------------------------------------------------------------

function parseOutput(runner: Exclude<Runner, "auto">, raw: string): TestResult {
  switch (runner) {
    case "bun":
    case "vitest":
    case "jest":
      return parseJestLike(raw);
    case "pytest":
      return parsePytest(raw);
    case "go":
      return parseGoTest(raw);
    default:
      return parseGenericTap(raw);
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const MAX_FAILURES_INLINE = 2;

function formatDuration(ms: number): string {
  if (ms === 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatFailure(f: TestFailure): string {
  const loc = [f.file, f.line].filter(Boolean).join(":");
  const header = `✗ ${loc ? loc + "  " : ""}"${f.testName}"`;
  const lines = [header];
  if (f.message) lines.push(`  ${f.message}`);
  for (const s of f.stack.slice(0, 4)) {
    lines.push(`    at ${s}`);
  }
  return lines.join("\n");
}

function formatResult(
  result: TestResult,
  failuresOnly: boolean,
  bypassSummary: boolean,
): string {
  const { pass, fail, skip, durationMs, failures } = result;

  const summary = `[ashlr__test] ${pass} pass · ${fail} fail · ${skip} skip · in ${formatDuration(durationMs)}`;

  if (fail === 0) {
    return summary + "\n\nAll tests passed.";
  }

  const lines: string[] = [summary, ""];

  const toShow = bypassSummary ? failures : failures.slice(0, MAX_FAILURES_INLINE);
  for (const f of toShow) {
    lines.push(formatFailure(f));
    lines.push("");
  }

  const remaining = failures.length - toShow.length;
  if (!bypassSummary && remaining > 0) {
    lines.push(`(${remaining} more failure${remaining > 1 ? "s" : ""} — pass bypassSummary:true to see all)`);
  }

  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

export async function ashlrTest(input: TestOptions): Promise<string> {
  const clamp = clampToCwd(input.cwd, "ashlr__test");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;

  const requestedRunner: Runner = input.runner ?? "auto";
  const resolvedRunner: Exclude<Runner, "auto"> =
    requestedRunner === "auto" ? detectRunner(cwd) : requestedRunner;

  const cmd: string[] = input.command
    ? input.command.split(/\s+/)
    : buildCommand(resolvedRunner, input.files ?? []);

  let stdoutText: string;
  let stderrText: string;
  try {
    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf-8",
    });
    stdoutText = (result.stdout as string) ?? "";
    stderrText = (result.stderr as string) ?? "";
    if (result.error) {
      return `[ashlr__test] failed to spawn: ${result.error.message}`;
    }
  } catch (err: unknown) {
    return `[ashlr__test] failed to spawn: ${String(err)}`;
  }

  const raw = stdoutText + (stderrText ? "\n" + stderrText : "");

  // If command was provided verbatim we don't know the runner; try heuristics
  const effectiveRunner: Exclude<Runner, "auto"> = input.command
    ? detectRunnerFromOutput(raw, resolvedRunner)
    : resolvedRunner;

  let result: TestResult;
  try {
    result = parseOutput(effectiveRunner, raw);
  } catch {
    result = parseGenericTap(raw);
  }

  // Fallback: if parsers found nothing meaningful, try generic
  if (result.pass + result.fail + result.skip === 0) {
    const generic = parseGenericTap(raw);
    if (generic.pass + generic.fail + generic.skip > 0) result = generic;
  }

  const failuresOnly = input.failuresOnly ?? true;
  const bypassSummary = input.bypassSummary ?? false;

  return formatResult(result, failuresOnly, bypassSummary);
}

function detectRunnerFromOutput(raw: string, fallback: Exclude<Runner, "auto">): Exclude<Runner, "auto"> {
  if (/^{.*"Action"/m.test(raw)) return "go";
  if (/=+\s*\d+\s+(?:passed|failed).*in\s+\d/.test(raw)) return "pytest";
  if (/PASS|FAIL\s/.test(raw) && /\d+\s+pass/.test(raw)) return "bun";
  return fallback;
}

// ---------------------------------------------------------------------------
// Registration (side-effect on import)
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__test",
  description:
    "Run a test suite and return structured, token-efficient failure output. Supports bun test, vitest, jest, pytest, go test, and a generic fallback. Parses runner output into pass/fail/skip counts plus per-failure file:line + message + stack — eliminating the read-source-fix-rerun loop that wastes 25–30% of tokens on test-driven workflows.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Full command to run verbatim (e.g. 'bun test src/foo.test.ts'). Overrides runner + files.",
      },
      cwd: {
        type: "string",
        description: "Working directory (default: cwd). Must be inside the current cwd.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Specific test file paths to pass to the runner.",
      },
      runner: {
        type: "string",
        enum: ["auto", "bun", "vitest", "jest", "pytest", "go"],
        description: "Test runner to use. 'auto' detects from package.json / go.mod / pytest.ini (default: auto).",
      },
      failuresOnly: {
        type: "boolean",
        description: "Return only failure details, not per-test pass output (default: true).",
      },
      bypassSummary: {
        type: "boolean",
        description: "Show all failures instead of truncating at 2 inline (default: false).",
      },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrTest(args as unknown as TestOptions);
    return { content: [{ type: "text", text }] };
  },
});
