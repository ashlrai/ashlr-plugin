/**
 * pretooluse-websearch-hook.test.ts — hook-level tests for the WebSearch
 * PreToolUse wrapper.
 *
 * pretooluse-coverage.test.ts covers the Glob, NotebookEdit and WebFetch
 * wrappers, which only ever nudge or pass through. WebSearch is the one
 * wrapper whose default mode is a hard redirect-block, so it gets its own
 * file: the deny decision, the canonical MCP tool name in the reason, query
 * escaping, and the nudge/off/bypass exits.
 *
 * Hermetic: the hook runs as a subprocess with a mkdtemp HOME (no
 * ~/.ashlr/config.json → default redirect mode) and never touches the
 * network — the native WebSearch tool is blocked before it runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const HOOK = resolve(__dirname, "..", "hooks", "pretooluse-websearch.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-ptu-websearch-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

interface HookRun {
  stdout: string;
  exitCode: number;
  timings: Array<Record<string, unknown>>;
}

async function runHook(
  payload: string,
  extraEnv: Record<string, string> = {},
): Promise<HookRun> {
  const proc = spawn({
    cmd: ["bun", "run", HOOK],
    cwd: resolve(__dirname, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: (() => {
      // Strip mode env so each test's baseline is the default redirect mode.
      const { ASHLR_HOOK_MODE: _hm, ASHLR_ENFORCE: _en, ASHLR_MCP_HOST: _mh, ...clean } = process.env;
      void _hm; void _en; void _mh;
      return { ...clean, HOME: home, ...extraEnv };
    })(),
  });
  proc.stdin.write(payload);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const timingsRaw = await readFile(join(home, ".ashlr", "hook-timings.jsonl"), "utf-8").catch(() => "");
  const timings = timingsRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { stdout, exitCode, timings };
}

function parseOut(stdout: string): { hookSpecificOutput: Record<string, unknown> } {
  return JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> };
}

describe("pretooluse-websearch", () => {
  test("default mode denies the native call and routes to ashlr__websearch", async () => {
    const { stdout, exitCode, timings } = await runHook(
      JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "bun test coverage flags" } }),
    );
    expect(exitCode).toBe(0);
    const out = parseOut(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.hookEventName).toBe("PreToolUse");
    const reason = out.permissionDecisionReason as string;
    expect(reason).toContain("mcp__plugin_ashlr_ashlr__ashlr__websearch");
    expect(reason).toContain('"query": "bun test coverage flags"');
    expect(reason).toContain("ASHLR_HOOK_MODE=nudge");
    const record = timings.find((r) => r.hook === "pretooluse-websearch");
    expect(record).toMatchObject({ tool: "WebSearch", outcome: "block" });
  });

  test("quotes and backslashes in the query are escaped in the reason", async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: "WebSearch", tool_input: { query: 'say "hi" \\ done' } }),
    );
    const reason = parseOut(stdout).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('{ "query": "say \\"hi\\" \\\\ done" }');
  });

  test("a missing query still blocks with a placeholder", async () => {
    const { stdout, exitCode } = await runHook(JSON.stringify({ tool_name: "WebSearch", tool_input: {} }));
    expect(exitCode).toBe(0);
    const out = parseOut(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("<query>");
  });

  test("nudge mode suggests ashlr__websearch without denying", async () => {
    const { stdout, exitCode, timings } = await runHook(
      JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "mdx angle bracket" } }),
      { ASHLR_HOOK_MODE: "nudge" },
    );
    expect(exitCode).toBe(0);
    const out = parseOut(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBeUndefined();
    const context = out.additionalContext as string;
    expect(context).toContain("ashlr__websearch");
    expect(context).toContain("mdx angle bracket");
    expect(timings.find((r) => r.hook === "pretooluse-websearch")).toMatchObject({ outcome: "ok" });
  });

  test("off mode passes through silently", async () => {
    const { stdout, exitCode } = await runHook(
      JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "anything" } }),
      { ASHLR_HOOK_MODE: "off" },
    );
    expect(exitCode).toBe(0);
    const out = parseOut(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toBeUndefined();
  });

  test("non-WebSearch tool names exit 0 with no hook output", async () => {
    const { stdout, exitCode, timings } = await runHook(
      JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(timings.find((r) => r.hook === "pretooluse-websearch")).toMatchObject({ tool: "WebFetch", outcome: "ok" });
  });

  test("a bypass payload passes through untouched", async () => {
    const { stdout, exitCode, timings } = await runHook(
      JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "x", bypassSummary: true } }),
    );
    expect(exitCode).toBe(0);
    // The bypass exit is silent: no stdout, native call proceeds untouched.
    expect(stdout).toBe("");
    expect(timings.find((r) => r.hook === "pretooluse-websearch")).toMatchObject({ outcome: "bypass" });
  });

  test("malformed stdin exits 0 with no hook output", async () => {
    const { stdout, exitCode } = await runHook("not json at all");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});
