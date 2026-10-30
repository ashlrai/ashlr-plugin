import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetWatch } from "../scripts/fleet-watch";
let home: string, root: string, output: string[], errors: string[];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-watch-")));
  root = join(home, ".ashlr");
  mkdirSync(join(root, "metrics"), { recursive: true });
  writeFileSync(join(root, "dispatch-events.log"), '{"event":"old"}\nbroken\n{"event":"new","private":"omitted"}\n');
  writeFileSync(join(root, "metrics/jobs.jsonl"), '{"status":"done"}\n');
  output = []; errors = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const deps = () => ({ root, stdout: (s: string) => { output.push(s); }, stderr: (s: string) => { errors.push(s); } });
test("since resumes independent physical cursors and emits only typed NDJSON", async () => {
  expect(await fleetWatch(["--since", "v1:2:0"], deps())).toBe(0);
  expect(output.map(s => JSON.parse(s))).toEqual([
    { source: "dispatch-events.log", line: 3, type: "new", timestamp: null, job_id: null },
    { source: "metrics/jobs.jsonl", line: 1, type: "done", timestamp: null, job_id: null },
  ]);
  expect(errors).toEqual([]);
});
test("drains every page without following", async () => {
  writeFileSync(join(root, "dispatch-events.log"), '{"event":"dispatch"}\n'.repeat(401));
  expect(await fleetWatch([], deps())).toBe(0);
  expect(output).toHaveLength(402);
  expect(JSON.parse(output[400]!).line).toBe(401);
});
test("rejects invalid arguments and stale cursors without rewinding", async () => {
  for (const args of [["--since"], ["--wat"], ["--since", "bad"], ["--since", "v1:99:1"]]) {
    expect(await fleetWatch(args, deps())).toBe(1);
  }
  expect(output).toEqual([]);
  expect(errors).toHaveLength(4);
});
test("follow consumes completed appends once and terminates on abort", async () => {
  const controller = new AbortController();
  let polls = 0;
  expect(await fleetWatch(["--since", "v1:3:1", "--follow"], {
    ...deps(), signal: controller.signal,
    wait: async () => {
      polls++;
      if (polls === 1) appendFileSync(join(root, "dispatch-events.log"), '{"event":"appended"}');
      else if (polls === 2) appendFileSync(join(root, "dispatch-events.log"), '\n');
      else controller.abort();
    },
  })).toBe(0);
  expect(polls).toBe(3);
  expect(output.map(s => JSON.parse(s).type)).toEqual(["appended"]);
});
test.each(["SIGINT", "SIGTERM"] as const)("CLI follow exits cleanly on %s while waiting", async signal => {
  const child = Bun.spawn([process.execPath, "scripts/fleet-watch.ts", "--follow"], {
    env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    child.kill(signal);
    expect(await child.exited).toBe(0);
    reader.releaseLock();
    expect(await new Response(child.stderr).text()).toContain('"invalid"');
  } finally { child.kill(); }
});
test("follow survives missing sources and reports a failed output stream", async () => {
  rmSync(join(root, "metrics/jobs.jsonl"));
  const controller = new AbortController();
  let polls = 0;
  expect(await fleetWatch(["--since", "v1:3:0", "--follow"], {
    ...deps(), signal: controller.signal,
    wait: async () => {
      if (++polls === 1) writeFileSync(join(root, "metrics/jobs.jsonl"), '{"status":"created"}\n');
      else controller.abort();
    },
  })).toBe(0);
  expect(output.map(s => JSON.parse(s).type)).toEqual(["created"]);
  expect(errors).toHaveLength(1);
  expect(await fleetWatch([], { ...deps(), stdout: async () => { throw new Error("fixture"); } })).toBe(1);
});
