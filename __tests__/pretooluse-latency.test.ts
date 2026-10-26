import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Measure complete subprocess lifetime, including imports and the ledger flush.
// The ceiling tolerates loaded runners while catching multi-second regressions.
for (const name of ["read", "grep", "edit", "common"]) {
  test(`${name} cold pass-through persists timing within 5 seconds`, async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-hook-latency-"));
    try {
      const hook = `pretooluse-${name}`;
      const args = name === "common"
        ? ["--eval", `const start = performance.now();
          const m = await import(${JSON.stringify(resolve("hooks/pretooluse-common.ts"))});
          m.recordHookTiming({hook: ${JSON.stringify(hook)}, durationMs: performance.now() - start, outcome: "ok"});
          await m.flushHookTimings();`]
        : [resolve(`hooks/${hook}.ts`)];
      const start = performance.now();
      const child = Bun.spawn([process.execPath, ...args], {
        env: { ...process.env, HOME: home, ASHLR_HOOK_TIMINGS: "1" },
        stdin: new TextEncoder().encode('{"tool_name":"Other","tool_input":{}}'),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(performance.now() - start).toBeLessThan(5_000);
      const rows = (await readFile(join(home, ".ashlr/hook-timings.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hook, outcome: "ok" });
      expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
}

test("common defers the ledger and Bash registry until needed", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    const m = await import(${JSON.stringify(resolve("hooks/pretooluse-common.ts"))});
    const loaded = (name) => Object.keys(require.cache).some(path => path.includes(name));
    if (loaded('_hook-timing-ledger') || loaded('_bash-summarizers-registry')) process.exit(1);
    m.buildNudgeContext('Read', {file_path: '/missing'});
    if (loaded('_bash-summarizers-registry')) process.exit(2);
    m.buildNudgeContext('Bash', {command: 'git status'});
    if (!loaded('_bash-summarizers-registry')) process.exit(3);
  `], { env: { ...process.env, ASHLR_HOOK_TIMINGS: "0" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
});
