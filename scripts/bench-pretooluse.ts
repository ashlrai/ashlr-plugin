import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run from either checkout to compare identical cold subprocess workloads.
// Two warmups and ten measured calls, with real ledger persistence enabled.
const home = mkdtempSync(join(tmpdir(), "ashlr-hook-bench-"));
try {
  for (const name of ["read", "grep", "edit", "common"]) {
    const times: number[] = [];
    const hook = name === "common" ? "common-import" : `pretooluse-${name}`;
    for (let i = 0; i < 12; i++) {
      const code = `const start = performance.now();
        const m = await import(${JSON.stringify(resolve("hooks/pretooluse-common.ts"))});
        m.recordHookTiming({hook: 'common-import', durationMs: performance.now() - start, outcome: 'ok'});
        await m.flushHookTimings();`;
      const args = name === "common" ? ["--eval", code] : [resolve(`hooks/${hook}.ts`)];
      const start = performance.now();
      const child = Bun.spawn([process.execPath, ...args], {
        env: { ...process.env, HOME: home, ASHLR_HOOK_TIMINGS: "1" },
        stdin: new TextEncoder().encode('{"tool_name":"Other","tool_input":{}}'),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, , stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Hook ${name} failed: ${stderr}`);
      if (i >= 2) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const rows = readFileSync(join(home, ".ashlr/hook-timings.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line))
      .filter((row) => row.hook === hook).slice(2);
    console.log(JSON.stringify({
      name, samples: times.length, p50Ms: times[4], p95Ms: times[9],
      ledgerMeanMs: rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length,
    }));
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
