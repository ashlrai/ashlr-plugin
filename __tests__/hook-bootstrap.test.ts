/**
 * hook-bootstrap.test.ts — behavioral tests for scripts/hook-bootstrap.mjs.
 *
 * Mirrors the pattern in bootstrap.test.ts: POSIX-only shell stubs for bun
 * and the hook target. The hook trampoline's contract differs from the MCP
 * bootstrap's in two important ways:
 *
 *   1. It must NEVER install bun (install races across concurrent hooks = bad).
 *   2. It must ALWAYS exit 0 — hooks must not gate the Claude Code harness.
 *      Even "bun is genuinely missing" is exit 0 silently, not exit 1.
 *
 * Windows is covered by scripts/smoke-cross-platform.ts + CI matrix; stub
 * shell scripts don't translate cleanly to .cmd/.exe shims.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const HOOK_BOOTSTRAP = resolve(
  import.meta.dir,
  "..",
  "scripts",
  "hook-bootstrap.mjs",
);
const NODE_BIN = process.platform === "win32"
  ? "node"
  : (spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim() || "node");

let SANDBOX_HOME: string;
let STUB_ROOT: string;

beforeAll(() => {
  SANDBOX_HOME = mkdtempSync(join(tmpdir(), "ashlr-hook-bootstrap-"));
  STUB_ROOT = mkdtempSync(join(tmpdir(), "ashlr-hook-bootstrap-stubs-"));
});

afterAll(() => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(STUB_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeStub(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Build a bun stub that records each invocation's argv into `recordPath`
 * (one arg per line). Exits 0 after recording so the trampoline's
 * spawnSync("bun", ...) sees a successful child.
 */
function bunStub(recordPath: string): string {
  return [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "1.0.0-stub"; exit 0; fi',
    `printf '%s\\n' "$@" >> "${recordPath}"`,
    "exit 0",
    "",
  ].join("\n");
}

const posix = process.platform === "win32" ? it.skip : it;

describe("scripts/hook-bootstrap.mjs", () => {
  posix("happy path: bun on PATH — forwards to `bun run <hook>`", () => {
    const recordPath = join(STUB_ROOT, "happy-record.txt");
    const bunDir = join(STUB_ROOT, "happy-bin");
    writeStub(bunDir, "bun", bunStub(recordPath));
    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      NODE_BIN,
      [HOOK_BOOTSTRAP, hookPath, "hook-arg-1"],
      {
        encoding: "utf8",
        env: {
          PATH: bunDir,
          HOME: SANDBOX_HOME,
          USERPROFILE: SANDBOX_HOME,
        },
      },
    );
    expect(result.status).toBe(0);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toBe(hookPath);
    expect(recorded[2]).toBe("hook-arg-1");
  });

  posix("PATH gap recovery: bun missing from PATH but present in ~/.bun/bin", () => {
    // Fresh sandbox home so the fake ~/.bun/bin/bun is all we've got.
    const sandbox = mkdtempSync(join(tmpdir(), "ashlr-hook-recovery-"));
    const bunBinDir = join(sandbox, ".bun", "bin");
    const recordPath = join(STUB_ROOT, "recovery-record.txt");
    writeStub(bunBinDir, "bun", bunStub(recordPath));
    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      NODE_BIN,
      [HOOK_BOOTSTRAP, hookPath],
      {
        encoding: "utf8",
        env: {
          // Empty PATH so the first hasBun() fails and forces prependBunToPath().
          PATH: "",
          HOME: sandbox,
          USERPROFILE: sandbox,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(existsSync(recordPath)).toBe(true);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toBe(hookPath);

    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  });

  posix("bun truly missing: exits 0 silently and does NOT attempt install", () => {
    // PATH is empty and ~/.bun/bin does not exist. The trampoline must exit 0
    // without invoking any bash/powershell installer (hooks never install).
    const sandbox = mkdtempSync(join(tmpdir(), "ashlr-hook-missing-"));
    const installerCanary = join(STUB_ROOT, "installer-canary.txt");

    // Place a bash stub on PATH that writes to the canary if invoked —
    // proving the trampoline did NOT try to shell out to the bun installer.
    const trapDir = join(STUB_ROOT, "trap-bin");
    writeStub(
      trapDir,
      "bash",
      ["#!/bin/sh", `echo "invoked" > "${installerCanary}"`, "exit 0", ""].join("\n"),
    );

    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      NODE_BIN,
      [HOOK_BOOTSTRAP, hookPath],
      {
        encoding: "utf8",
        env: {
          PATH: trapDir, // only bash is here, no bun
          HOME: sandbox,
          USERPROFILE: sandbox,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(existsSync(installerCanary)).toBe(false);

    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  });

  posix("ASHLR_NO_AUTO_INSTALL=1 does not block PATH resolution", () => {
    // The opt-out flag only gates installation; the trampoline should still
    // probe ~/.bun/bin and route the hook through it.
    const sandbox = mkdtempSync(join(tmpdir(), "ashlr-hook-noinstall-"));
    const bunBinDir = join(sandbox, ".bun", "bin");
    const recordPath = join(STUB_ROOT, "noinstall-record.txt");
    writeStub(bunBinDir, "bun", bunStub(recordPath));
    const hookPath = join(STUB_ROOT, "fake-hook.ts");
    writeFileSync(hookPath, "// stub hook\n");

    const result = spawnSync(
      NODE_BIN,
      [HOOK_BOOTSTRAP, hookPath],
      {
        encoding: "utf8",
        env: {
          PATH: "",
          HOME: sandbox,
          USERPROFILE: sandbox,
          ASHLR_NO_AUTO_INSTALL: "1",
        },
      },
    );
    expect(result.status).toBe(0);
    const recorded = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
    expect(recorded[0]).toBe("run");
    expect(recorded[1]).toBe(hookPath);

    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  });

  posix("missing hook path argument exits 0 (never gates the harness)", () => {
    const result = spawnSync(NODE_BIN, [HOOK_BOOTSTRAP], {
      encoding: "utf8",
      env: { PATH: "", HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("missing hook path argument");
  });
});

describe("scripts/hook-bootstrap.mjs --group", () => {
  function hook(name: string, body: string): string {
    const p = join(STUB_ROOT, `${name}.ts`);
    writeFileSync(p, body);
    return p;
  }

  function runGroup(args: string[], payload: Record<string, unknown>) {
    return spawnSync(NODE_BIN, [HOOK_BOOTSTRAP, "--group", ...args], {
      encoding: "utf8",
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME },
    });
  }

  const ctx = (text: string) =>
    `await Bun.stdin.text(); console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ${JSON.stringify(text)} } }));\n`;

  it("runs only the hooks whose matcher fits the tool and joins their context", () => {
    const a = hook("group-a", ctx("from a"));
    const b = hook("group-b", ctx("from b"));
    const c = hook("group-c", ctx("from c"));
    const result = runGroup(["--match", "Read|Grep", a, "--match", "Edit", b, c], {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toBe("from a\n\nfrom c");
  });

  it("matchers cover the whole tool name", () => {
    const a = hook("group-whole", ctx("ran"));
    const result = runGroup(["--match", "Read", a], { hook_event_name: "PostToolUse", tool_name: "mcp__x__Read" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("every hook sees the same stdin payload", () => {
    const echo = hook(
      "group-echo",
      'const p = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: p.session_id } }));\n',
    );
    const result = runGroup([echo, echo], { hook_event_name: "SessionStart", session_id: "s-123" });
    const out = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toBe("s-123\n\ns-123");
  });

  it("keeps plain-text output and merges it into context when mixed with JSON", () => {
    const plainA = hook("group-plain-a", 'console.log("plain a");\n');
    const plainB = hook("group-plain-b", 'console.log("plain b");\n');
    const json = hook("group-json", ctx("json"));
    const onlyPlain = runGroup([plainA, plainB], { hook_event_name: "SessionStart" });
    expect(onlyPlain.stdout).toBe("plain a\n\nplain b\n");
    const mixed = runGroup([json, plainA], { hook_event_name: "SessionStart" });
    const out = JSON.parse(mixed.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: "json\n\nplain a" });
  });

  it("exit code 2 from any hook blocks, and stderr is passed through", () => {
    const ok = hook("group-ok", ctx("fine"));
    const block = hook("group-block", 'console.error("blocked: reason"); process.exit(2);\n');
    const result = runGroup([ok, block], { hook_event_name: "PostToolUse", tool_name: "Edit" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("blocked: reason");
  });

  it("hooks run in parallel", () => {
    const slow = hook("group-slow", `
const started = Date.now();
await Bun.sleep(400);
console.log("timing " + JSON.stringify({ started, finished: Date.now() }));
`);
    const result = runGroup([slow, slow, slow, slow], { hook_event_name: "PostToolUse", tool_name: "Read" });
    expect(result.status).toBe(0);
    const timings = result.stdout.trim().split(/\n+/).map((line) =>
      JSON.parse(line.slice("timing ".length)) as { started: number; finished: number });
    expect(timings).toHaveLength(4);
    for (const timing of timings) {
      expect(timing.finished - timing.started).toBeGreaterThanOrEqual(400);
    }
    // Measure the hooks' execution window, excluding the cold Node/Bun
    // startup before any hook runs. Serial execution still takes >=1600ms.
    expect(Math.max(...timings.map((t) => t.finished))
      - Math.min(...timings.map((t) => t.started))).toBeLessThan(1500);
  });
});
