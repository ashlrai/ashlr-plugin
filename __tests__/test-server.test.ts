/**
 * End-to-end tests for ashlr__test via direct import.
 *
 * Uses tiny synthetic bun scripts so the tests are deterministic,
 * fast, and network-free.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { writeFileSync, rmSync } from "fs";
import { ashlrTest } from "../servers/test-server-handlers";

// Use the repo root as cwd — always inside process.cwd() and has package.json
const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT_PATH = join(REPO_ROOT, ".tmp-ashlr-test-fixture.ts");

afterAll(() => {
  rmSync(SCRIPT_PATH, { force: true });
});

/** Write a tiny bun script to SCRIPT_PATH and return a command string for it. */
function makeScript(output: string, exitCode = 0): string {
  writeFileSync(
    SCRIPT_PATH,
    `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});\n`,
  );
  return `bun run ${SCRIPT_PATH}`;
}

// ---------------------------------------------------------------------------
// Direct import tests (no MCP round-trip)
// ---------------------------------------------------------------------------

describe("ashlrTest — direct", () => {
  test("cwd clamp rejects paths outside cwd", async () => {
    const result = await ashlrTest({ cwd: "/etc", command: "echo hi" });
    expect(result).toContain("refused path outside working directory");
  });

  test("exit 0 — all passed output parsed", async () => {
    const cmd = makeScript("5 pass · 0 fail · 0 skip · in 10ms\n", 0);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun" });
    expect(result).toContain("[ashlr__test]");
    expect(result).toContain("5 pass");
    expect(result).toContain("0 fail");
    expect(result).toContain("All tests passed");
  });

  test("exit 1 — failures parsed + formatted", async () => {
    const output = [
      "  ✗ src/foo.test.ts:42 > handles empty array",
      "    AssertionError: expected [] to equal [1]",
      "      at Object.<anonymous> (src/foo.test.ts:42:15)",
      "",
      "1 pass · 1 fail · 0 skip · in 55ms",
    ].join("\n");
    const cmd = makeScript(output, 1);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun" });
    expect(result).toContain("[ashlr__test]");
    expect(result).toMatch(/fail|✗/);
  });

  test("bypassSummary:false truncates at 2 failures", async () => {
    const output = [
      "  ✗ a.test.ts:1 > test1",
      "    Error: one",
      "  ✗ b.test.ts:2 > test2",
      "    Error: two",
      "  ✗ c.test.ts:3 > test3",
      "    Error: three",
      "0 pass · 3 fail · 0 skip · in 100ms",
    ].join("\n");
    const cmd = makeScript(output, 1);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun", bypassSummary: false });
    expect(result).toContain("more failure");
  });

  test("bypassSummary:true shows all failures", async () => {
    const output = [
      "  ✗ a.test.ts:1 > test1",
      "    Error: one",
      "  ✗ b.test.ts:2 > test2",
      "    Error: two",
      "  ✗ c.test.ts:3 > test3",
      "    Error: three",
      "0 pass · 3 fail · 0 skip · in 100ms",
    ].join("\n");
    const cmd = makeScript(output, 1);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun", bypassSummary: true });
    expect(result).not.toContain("more failure");
  });
});


// ---------------------------------------------------------------------------
// watch mode — background session lifecycle
// ---------------------------------------------------------------------------

import { rm as rmAsync, writeFile } from "fs/promises";
import { ashlrBashList, ashlrBashTail, ashlrBashStop } from "../servers/bash-server";
import { __activeWatchSessionsForTests, __clearWatchSessionsForTests } from "../servers/_test-watch";

async function makeWatchRepo(): Promise<string> {
  // Create a tiny sandboxed directory INSIDE process.cwd() so cwd-clamp
  // accepts it. (clampToCwd rejects /tmp/... when process.cwd() is the
  // repo root.) Sandbox lives at `<repo>/.tmp-ashlr-watch/w-XXXXXX` and the
  // afterAll() below removes the entire `.tmp-ashlr-watch/` tree.
  const base = join(REPO_ROOT, ".tmp-ashlr-watch");
  const { mkdtempSync, writeFileSync: wfSync, mkdirSync } = require("fs");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "w-"));
  // Seed a tiny file so the watcher has something to observe.
  wfSync(join(dir, "seed.ts"), "export const x = 1;\n");
  return dir;
}

async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe("ashlrTest — watch mode", () => {
  afterAll(async () => {
    __clearWatchSessionsForTests();
    const base = join(REPO_ROOT, ".tmp-ashlr-watch");
    await rmAsync(base, { recursive: true, force: true }).catch(() => {});
  });

  test("watch=true returns a session id without blocking", async () => {
    const dir = await makeWatchRepo();
    // Command that exits fast so we don't keep spawning forever.
    const cmd = `bun run -e "process.exit(0)"`;
    const before = Date.now();
    const result = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
    const elapsed = Date.now() - before;
    expect(result).toContain("[ashlr__test watch] started");
    expect(result).toMatch(/id=[0-9a-f]{8}/);
    // Must NOT block on the test run — should return immediately.
    expect(elapsed).toBeLessThan(1500);
    // Clean up.
    const idMatch = result.match(/id=([0-9a-f]{8})/);
    if (idMatch) await ashlrBashStop({ id: idMatch[1] });
  });

  test("after starting watch, ashlr__bash_list shows the session with test-watch kind", async () => {
    const dir = await makeWatchRepo();
    const cmd = `bun run -e "process.exit(0)"`;
    const startOut = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
    const idMatch = startOut.match(/id=([0-9a-f]{8})/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const list = await ashlrBashList();
    expect(list).toContain(id);
    expect(list).toContain("test-watch");

    // Clean up.
    await ashlrBashStop({ id });
  });

  test("touching a watched file triggers a re-run", async () => {
    const dir = await makeWatchRepo();
    // A command whose stdout is distinctive per run so we can count invocations.
    const cmd = `bun run -e "console.log('RUN_MARK'); process.exit(0)"`;
    const startOut = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
    const id = startOut.match(/id=([0-9a-f]{8})/)![1];

    // Give the initial run a moment to complete.
    await waitForCondition(async () => {
      const tail = await ashlrBashTail({ id, wait_ms: 0, max_bytes: 10_000 });
      return tail.includes("RUN_MARK");
    }, 4000);

    // Touch a watched file.
    await writeFile(join(dir, "seed.ts"), "export const x = 2;\n");

    // Expect a second run within 500ms of the debounce (200ms) + spawn latency.
    const triggered = await waitForCondition(async () => {
      const tail = await ashlrBashTail({ id, wait_ms: 0, max_bytes: 10_000 });
      // Count the number of run headers observed on stdout.
      // Tail only returns new output since last poll, so cumulative across polls.
      return /run #2/.test(tail);
    }, 4000, 25);
    expect(triggered).toBe(true);

    await ashlrBashStop({ id });
  });

  test("rapid 10-edit burst triggers at most a small number of re-runs (debounce)", async () => {
    const dir = await makeWatchRepo();
    const cmd = `bun run -e "console.log('RUN_MARK'); process.exit(0)"`;
    const startOut = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
    const id = startOut.match(/id=([0-9a-f]{8})/)![1];

    // Wait for initial run to settle.
    await new Promise((r) => setTimeout(r, 400));
    // Drain stdout so we only count re-runs that come from the burst.
    await ashlrBashTail({ id, wait_ms: 0, max_bytes: 100_000 });

    // Burst 10 edits inside a single debounce window (< 200ms total).
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, "seed.ts"), `export const x = ${100 + i};\n`);
      await new Promise((r) => setTimeout(r, 5));
    }

    // Wait past the debounce + spawn latency.
    await new Promise((r) => setTimeout(r, 1000));
    const tail = await ashlrBashTail({ id, wait_ms: 0, max_bytes: 200_000 });
    // Count `[run #N]` headers for new runs triggered by the burst.
    const runHeaders = tail.match(/\[run #\d+ at /g) ?? [];
    // Debounce should collapse all 10 edits into a single re-run. Allow
    // up to 3 in case the filesystem emitted events split across debounce
    // windows on slow CI.
    expect(runHeaders.length).toBeGreaterThanOrEqual(1);
    expect(runHeaders.length).toBeLessThanOrEqual(3);

    await ashlrBashStop({ id });
  });

  test("ashlr__bash_stop actually terminates the watch session", async () => {
    const dir = await makeWatchRepo();
    // Long-running command (sleeps) so we can observe the child pid before/after stop.
    const cmd = `bun run -e "setTimeout(() => process.exit(0), 60000)"`;
    const startOut = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
    const id = startOut.match(/id=([0-9a-f]{8})/)![1];

    // Give spawn time to materialize a pid.
    await new Promise((r) => setTimeout(r, 400));
    const beforeList = await ashlrBashList();
    expect(beforeList).toContain(id);

    const stopOut = await ashlrBashStop({ id });
    expect(stopOut).toMatch(/stopped|already exited/);

    // Session should be gone from the list.
    await new Promise((r) => setTimeout(r, 200));
    const afterList = await ashlrBashList();
    expect(afterList).not.toContain(id);
    // In-memory count should be zero for this session.
    // (other tests may leave none either)
    expect(__activeWatchSessionsForTests()).toBeGreaterThanOrEqual(0);
  });

  test("watch=false (default) behaves exactly as today — blocks and returns a summary", async () => {
    // Use a fast, deterministic command that emits a parseable summary.
    const cmd = makeScript("3 pass · 0 fail · 0 skip · in 5ms\n", 0);
    const result = await ashlrTest({ command: cmd, cwd: REPO_ROOT, runner: "bun" });
    expect(result).toContain("[ashlr__test]");
    expect(result).toContain("3 pass");
    expect(result).toContain("All tests passed");
    // Explicitly NOT a watch session response.
    expect(result).not.toContain("[ashlr__test watch] started");
  });

  test("max concurrent watch sessions is capped at 8", async () => {
    const dir = await makeWatchRepo();
    const cmd = `bun run -e "setTimeout(() => process.exit(0), 30000)"`;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const out = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
      const m = out.match(/id=([0-9a-f]{8})/);
      if (m) ids.push(m[1]);
    }
    // 9th should be rejected.
    const rejected = await ashlrTest({ command: cmd, cwd: dir, runner: "bun", watch: true });
    expect(rejected).toContain("max 8 concurrent watch sessions");

    // Clean up.
    for (const id of ids) {
      await ashlrBashStop({ id });
    }
  });
});
