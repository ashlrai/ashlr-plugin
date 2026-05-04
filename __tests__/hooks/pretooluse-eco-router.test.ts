/**
 * Tests for pretooluse-eco-router.ts
 *
 * Tests route() and buildOutput() directly for unit coverage.
 * Integration tests spawn the hook with crafted stdin payloads.
 */

import { describe, expect, test } from "bun:test";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { route, buildOutput, type RouteOpts } from "../../hooks/pretooluse-eco-router";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Unit: route() — eco off
// ---------------------------------------------------------------------------

describe("route(): eco mode off", () => {
  test("passes when ASHLR_ECO is unset", () => {
    const result = route({ tool_name: "Task", tool_input: { prompt: "what does this do?" } }, { ecoMode: undefined });
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("eco_off");
  });

  test("passes when ASHLR_ECO=0", () => {
    const result = route({ tool_name: "Task", tool_input: { prompt: "what does this do?" } }, { ecoMode: "0" });
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("eco_off");
  });

  test("passes for any tool when eco is off", () => {
    const result = route({ tool_name: "Read", tool_input: { file_path: "/foo.ts" } }, { ecoMode: "0" });
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Unit: route() — eco on, wrong tool
// ---------------------------------------------------------------------------

describe("route(): eco on, non-Task tool", () => {
  const opts: RouteOpts = { ecoMode: "1" };

  test("passes for Read tool", () => {
    const result = route({ tool_name: "Read" }, opts);
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("not_task");
  });

  test("passes for Bash tool", () => {
    const result = route({ tool_name: "Bash" }, opts);
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("not_task");
  });

  test("passes for Grep tool", () => {
    const result = route({ tool_name: "Grep" }, opts);
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("not_task");
  });

  test("passes for Edit tool", () => {
    const result = route({ tool_name: "Edit" }, opts);
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("not_task");
  });
});

// ---------------------------------------------------------------------------
// Unit: route() — eco on, Task with subagent_type already set
// ---------------------------------------------------------------------------

describe("route(): eco on, Task with explicit subagent_type", () => {
  const opts: RouteOpts = { ecoMode: "1" };

  test("passes through when subagent_type is already set", () => {
    const result = route(
      { tool_name: "Task", tool_input: { prompt: "what is this?", subagent_type: "ashlr:ashlr:code" } },
      opts,
    );
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("subagent_already_set");
  });

  test("passes through when subagent_type is explore (already set)", () => {
    const result = route(
      { tool_name: "Task", tool_input: { prompt: "explain this module", subagent_type: "ashlr:ashlr:explore" } },
      opts,
    );
    expect(result.action).toBe("pass");
    expect(result.reason).toBe("subagent_already_set");
  });
});

// ---------------------------------------------------------------------------
// Unit: route() — eco on, Task, question-shaped prompts
// ---------------------------------------------------------------------------

describe("route(): eco on, Task, question-shaped prompts → inject", () => {
  const opts: RouteOpts = { ecoMode: "1" };

  const questionPrompts = [
    "what does this function do?",
    "where is the genome cache stored?",
    "how does the router dispatch requests?",
    "find all usages of recordResult",
    "explain the session-log format",
    "why does the budget guard use bytes/4?",
    "which files import _nudge-events?",
    "when is the genome refreshed?",
    "who calls staleByteTotal?",
    "WHAT IS THE PURPOSE of this module", // uppercase
    "How does compression work",           // mixed case
    "WHERE should I add the new hook",     // uppercase
  ];

  for (const prompt of questionPrompts) {
    test(`injects for: "${prompt.slice(0, 50)}"`, () => {
      const result = route({ tool_name: "Task", tool_input: { prompt } }, opts);
      expect(result.action).toBe("inject");
      expect(result.subagent_type).toBe("ashlr:ashlr:explore");
    });
  }
});

// ---------------------------------------------------------------------------
// Unit: route() — eco on, Task, non-question prompts → pass
// ---------------------------------------------------------------------------

describe("route(): eco on, Task, non-question prompts → pass", () => {
  const opts: RouteOpts = { ecoMode: "1" };

  const nonQuestionPrompts = [
    "refactor the genome pipeline to use streaming",
    "add rate limiting to the HTTP server",
    "update the budget guard threshold to 85%",
    "fix the failing test in savings-math.test.ts",
    "implement the new /ashlr-tier command",
    "run the test suite and report failures",
  ];

  for (const prompt of nonQuestionPrompts) {
    test(`does not inject for: "${prompt.slice(0, 50)}"`, () => {
      const result = route({ tool_name: "Task", tool_input: { prompt } }, opts);
      expect(result.action).toBe("pass");
      expect(result.reason).toBe("not_question_shaped");
    });
  }
});

// ---------------------------------------------------------------------------
// Unit: route() — edge cases
// ---------------------------------------------------------------------------

describe("route(): edge cases", () => {
  const opts: RouteOpts = { ecoMode: "1" };

  test("passes when Task has no tool_input", () => {
    const result = route({ tool_name: "Task" }, opts);
    // No prompt → not question-shaped → pass
    expect(result.action).toBe("pass");
  });

  test("passes when Task has empty prompt", () => {
    const result = route({ tool_name: "Task", tool_input: { prompt: "" } }, opts);
    expect(result.action).toBe("pass");
  });

  test("passes when Task has non-string prompt", () => {
    const result = route({ tool_name: "Task", tool_input: { prompt: 42 } }, opts);
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Unit: buildOutput()
// ---------------------------------------------------------------------------

describe("buildOutput()", () => {
  test("returns passThrough for pass action", () => {
    const out = buildOutput({}, { action: "pass", reason: "eco_off" });
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.toolInputOverride).toBeUndefined();
  });

  test("returns toolInputOverride with subagent_type for inject action", () => {
    const payload = { tool_name: "Task", tool_input: { prompt: "what is X?" } };
    const out = buildOutput(payload, { action: "inject", subagent_type: "ashlr:ashlr:explore" });
    expect(out.hookSpecificOutput.toolInputOverride).toBeDefined();
    expect(out.hookSpecificOutput.toolInputOverride!.subagent_type).toBe("ashlr:ashlr:explore");
  });

  test("preserves original input fields in toolInputOverride", () => {
    const payload = { tool_name: "Task", tool_input: { prompt: "what is X?", other: "value" } };
    const out = buildOutput(payload, { action: "inject", subagent_type: "ashlr:ashlr:explore" });
    expect(out.hookSpecificOutput.toolInputOverride!.prompt).toBe("what is X?");
    expect(out.hookSpecificOutput.toolInputOverride!.other).toBe("value");
  });

  test("additionalContext mentions eco routing when injecting", () => {
    const payload = { tool_name: "Task", tool_input: { prompt: "what is X?" } };
    const out = buildOutput(payload, { action: "inject", subagent_type: "ashlr:ashlr:explore" });
    expect(out.hookSpecificOutput.additionalContext).toContain("[ashlr eco]");
    expect(out.hookSpecificOutput.additionalContext).toContain("ashlr:ashlr:explore");
  });
});

// ---------------------------------------------------------------------------
// Integration: spawn the hook process
// ---------------------------------------------------------------------------

describe("pretooluse-eco-router: integration (spawned process)", () => {
  const HOOK_PATH = join(__dirname, "../../hooks/pretooluse-eco-router.ts");

  async function runHook(
    payload: object,
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("exits 0 always", async () => {
    const result = await runHook({ tool_name: "Task", tool_input: { prompt: "what is X?" } }, { ASHLR_ECO: "1" });
    expect(result.exitCode).toBe(0);
  });

  test("injects subagent_type for question-shaped Task when ASHLR_ECO=1", async () => {
    const result = await runHook(
      { tool_name: "Task", tool_input: { prompt: "what does the genome pipeline do?" } },
      { ASHLR_ECO: "1" },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { toolInputOverride?: { subagent_type?: string } };
    };
    expect(parsed.hookSpecificOutput.toolInputOverride?.subagent_type).toBe("ashlr:ashlr:explore");
  });

  test("does NOT inject when ASHLR_ECO is unset", async () => {
    const result = await runHook(
      { tool_name: "Task", tool_input: { prompt: "what does the genome pipeline do?" } },
      { ASHLR_ECO: "" },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { toolInputOverride?: unknown };
    };
    expect(parsed.hookSpecificOutput.toolInputOverride).toBeUndefined();
  });

  test("does NOT inject for non-question Task prompt when ASHLR_ECO=1", async () => {
    const result = await runHook(
      { tool_name: "Task", tool_input: { prompt: "refactor the genome pipeline" } },
      { ASHLR_ECO: "1" },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { toolInputOverride?: unknown };
    };
    expect(parsed.hookSpecificOutput.toolInputOverride).toBeUndefined();
  });

  test("does NOT inject for non-Task tool when ASHLR_ECO=1", async () => {
    const result = await runHook(
      { tool_name: "Read", tool_input: { file_path: "/foo.ts" } },
      { ASHLR_ECO: "1" },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { toolInputOverride?: unknown };
    };
    expect(parsed.hookSpecificOutput.toolInputOverride).toBeUndefined();
  });

  test("handles malformed stdin gracefully (exits 0)", async () => {
    const result = await runHook({} as object, { ASHLR_ECO: "1" });
    // Pass raw non-JSON
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: new TextEncoder().encode("NOT_JSON"),
      env: { ...process.env, ASHLR_ECO: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
