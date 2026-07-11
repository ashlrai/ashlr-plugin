import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  __setAfterReaperPrecheckForTest,
  __setBeforeStaleQuarantineForTest,
  appendHookTimingBatch,
  HOOK_TIMING_BATCH_MAX_BYTES,
  HOOK_TIMING_FILE_MAX_BYTES,
} from "../hooks/_hook-timing-ledger";

const ROOT = resolve(__dirname, "..");
const LEDGER_MODULE = join(ROOT, "hooks", "_hook-timing-ledger.ts");

let home: string;
let timingPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-bounded-timings-"));
  timingPath = join(home, ".ashlr", "hook-timings.jsonl");
});

afterEach(async () => {
  __setAfterReaperPrecheckForTest(null);
  __setBeforeStaleQuarantineForTest(null);
  await rm(home, { recursive: true, force: true });
});

function lineOfSize(size: number, ts = "2026-01-01T00:00:00.000Z"): string {
  const make = (hook: string) => JSON.stringify({
    ts,
    hook,
    tool: null,
    durationMs: 1,
    outcome: "ok",
  }) + "\n";
  const empty = make("");
  expect(Buffer.byteLength(empty)).toBeLessThan(size);
  const line = make("x".repeat(size - Buffer.byteLength(empty)));
  expect(Buffer.byteLength(line)).toBe(size);
  return line;
}

function expectCompleteJsonl(raw: Buffer): void {
  expect(raw.length === 0 || raw[raw.length - 1] === 0x0a).toBe(true);
  for (const line of raw.toString("utf8").split("\n").filter(Boolean)) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("bounded hook timing ledger", () => {
  test("rotates an active file at the exact 16 MiB cap", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const existing = lineOfSize(1024).repeat(HOOK_TIMING_FILE_MAX_BYTES / 1024);
    await writeFile(timingPath, existing);
    const batch = lineOfSize(512, "2026-01-02T00:00:00.000Z");

    appendHookTimingBatch(timingPath, batch);

    const [active, retained] = await Promise.all([
      readFile(timingPath),
      readFile(`${timingPath}.1`),
    ]);
    expect(active.toString()).toBe(batch);
    expect(retained.length).toBe(HOOK_TIMING_FILE_MAX_BYTES);
    expectCompleteJsonl(active);
    expectCompleteJsonl(retained);
    if (process.platform !== "win32") {
      expect(await mode(timingPath)).toBe(0o600);
      expect(await mode(`${timingPath}.1`)).toBe(0o600);
    }
  });

  test("migrates a complete JSONL file one byte over cap without splitting a line", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const existing =
      lineOfSize(1024).repeat(HOOK_TIMING_FILE_MAX_BYTES / 1024 - 1) +
      lineOfSize(1025, "2026-01-02T00:00:00.000Z");
    expect(Buffer.byteLength(existing)).toBe(HOOK_TIMING_FILE_MAX_BYTES + 1);
    await writeFile(timingPath, existing);

    appendHookTimingBatch(timingPath, lineOfSize(512, "2026-01-03T00:00:00.000Z"));

    const [active, retained] = await Promise.all([
      readFile(timingPath),
      readFile(`${timingPath}.1`),
    ]);
    expect(active.length).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expectCompleteJsonl(active);
    expectCompleteJsonl(retained);
    expect(active.toString()).toContain("2026-01-03T00:00:00.000Z");
  });

  test("migrates over 32 MiB and advances dropped-history metadata conservatively", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const active = lineOfSize(1024, "2024-01-01T00:00:00.000Z")
      .repeat((HOOK_TIMING_FILE_MAX_BYTES * 2) / 1024 + 1);
    await writeFile(timingPath, active);
    await writeFile(
      `${timingPath}.1`,
      lineOfSize(1024, "2025-06-01T00:00:00.000Z"),
    );

    appendHookTimingBatch(timingPath, lineOfSize(512, "2026-01-01T00:00:00.000Z"));

    const [newActive, retained, metadata] = await Promise.all([
      readFile(timingPath),
      readFile(`${timingPath}.1`),
      readFile(`${timingPath}.meta.json`, "utf8").then(JSON.parse),
    ]);
    expect(newActive.length).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expect(retained.length).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expectCompleteJsonl(newActive);
    expectCompleteJsonl(retained);
    expect(metadata).toEqual({
      schemaVersion: 1,
      droppedThrough: "2025-06-01T00:00:00.000Z",
      updatedAt: expect.any(String),
    });
    if (process.platform !== "win32") {
      expect(await mode(timingPath)).toBe(0o600);
      expect(await mode(`${timingPath}.1`)).toBe(0o600);
      expect(await mode(`${timingPath}.meta.json`)).toBe(0o600);
    }
  });

  test("marks drops at exactly 32 MiB when the appended batch evicts a row", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const chunk = lineOfSize(1024, "2024-04-01T00:00:00.000Z").repeat(1024);
    const handle = await open(timingPath, "w", 0o600);
    try {
      for (let i = 0; i < 32; i++) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    expect((await stat(timingPath)).size).toBe(HOOK_TIMING_FILE_MAX_BYTES * 2);

    appendHookTimingBatch(timingPath, lineOfSize(512, "2026-01-01T00:00:00.000Z"));

    const metadata = JSON.parse(await readFile(`${timingPath}.meta.json`, "utf8"));
    expect(metadata.droppedThrough).toBe("2024-04-01T00:00:00.000Z");
    expect((await stat(timingPath)).size).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expect((await stat(`${timingPath}.1`)).size).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
  });

  test("streams 500k small rows under 180 MiB peak RSS", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const smallRow = lineOfSize(120, "2024-01-01T00:00:00.000Z");
    const chunk = smallRow.repeat(1_000);
    const marker = lineOfSize(120, "2025-01-01T00:00:00.000Z");
    const handle = await open(timingPath, "w", 0o600);
    try {
      for (let i = 0; i < 500; i++) await handle.write(chunk);
      await handle.write("{malformed-tail-row}\n");
      await handle.write(marker);
    } finally {
      await handle.close();
    }
    await writeFile(`${timingPath}.1`, lineOfSize(1024, "2025-06-01T00:00:00.000Z"));
    const code = `
      import { appendHookTimingBatch } from ${JSON.stringify(LEDGER_MODULE)};
      appendHookTimingBatch(process.env.TIMING_PATH, ${JSON.stringify(lineOfSize(512, "2026-01-01T00:00:00.000Z"))});
      const measured = process.resourceUsage().maxRSS;
      const peakRss = measured < 1_000_000 ? measured * 1024 : measured;
      console.log(JSON.stringify({ peakRss }));
    `;
    const child = spawn({
      cmd: ["bun", "-e", code],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TIMING_PATH: timingPath },
    });
    const stdout = new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const { peakRss } = JSON.parse(await stdout) as { peakRss: number };

    expect(peakRss).toBeLessThan(180 * 1024 * 1024);
    const [active, retained, metadata] = await Promise.all([
      readFile(timingPath),
      readFile(`${timingPath}.1`),
      readFile(`${timingPath}.meta.json`, "utf8").then(JSON.parse),
    ]);
    expect(active.length).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expect(retained.length).toBeLessThanOrEqual(HOOK_TIMING_FILE_MAX_BYTES);
    expect(active.at(-1)).toBe(0x0a);
    expect(retained.at(-1)).toBe(0x0a);
    expect(Buffer.concat([retained, active]).toString("utf8")).toContain("2025-01-01T00:00:00.000Z");
    expect(Buffer.concat([retained, active]).toString("utf8")).not.toContain("malformed-tail-row");
    expect(metadata.droppedThrough).toBe("2025-06-01T00:00:00.000Z");
    expect((await readdir(join(home, ".ashlr"))).some((name) => name.includes(".migrate-")))
      .toBe(false);
  }, 20_000);

  test("normalizes a valid final object without newline before appending", async () => {
    const path = timingPath;
    await mkdir(join(path, ".."), { recursive: true });
    const final = JSON.stringify({
      ts: "2025-01-02T00:00:00.000Z",
      hook: "legacy-final",
      tool: null,
      durationMs: 2,
      outcome: "ok",
    });
    await writeFile(path, lineOfSize(512) + final);

    expect(appendHookTimingBatch(path, lineOfSize(512, "2026-01-01T00:00:00.000Z")))
      .toBe("written");

    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.hook)).toContain("legacy-final");
    expect(rows).toHaveLength(3);
  });

  test("oversized migration preserves valid noncanonical legacy objects", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    const legacy = JSON.stringify({
      outcome: "ok",
      durationMs: 3,
      tool: "Read",
      hook: "legacy-reordered-\\\"quoted",
      ts: "2025-01-02T00:00:00.000Z",
    });
    await writeFile(
      timingPath,
      lineOfSize(1024).repeat(HOOK_TIMING_FILE_MAX_BYTES / 1024) + legacy,
    );

    expect(appendHookTimingBatch(timingPath, lineOfSize(512, "2026-01-01T00:00:00.000Z")))
      .toBe("written");

    const combined = Buffer.concat([
      await readFile(`${timingPath}.1`),
      await readFile(timingPath),
    ]).toString("utf8");
    expect(combined).toContain("legacy-reordered");
    for (const line of combined.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("writes partial-history metadata when malformed or torn rows are discarded", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    await writeFile(timingPath, lineOfSize(512) + "{definitely-torn");

    appendHookTimingBatch(timingPath, lineOfSize(512, "2026-01-01T00:00:00.000Z"));

    const [raw, metadata] = await Promise.all([
      readFile(timingPath, "utf8"),
      readFile(`${timingPath}.meta.json`, "utf8").then(JSON.parse),
    ]);
    expect(raw).not.toContain("definitely-torn");
    expectCompleteJsonl(Buffer.from(raw));
    expect(metadata).toEqual({
      schemaVersion: 1,
      droppedThrough: null,
      updatedAt: expect.any(String),
    });
  });

  test("records the newest timestamp when rotation overwrites retained history", async () => {
    await mkdir(join(home, ".ashlr"), { recursive: true });
    await writeFile(
      timingPath,
      lineOfSize(1024).repeat(HOOK_TIMING_FILE_MAX_BYTES / 1024),
    );
    await writeFile(
      `${timingPath}.1`,
      lineOfSize(1024, "2025-12-31T23:59:59.000Z"),
    );

    appendHookTimingBatch(timingPath, lineOfSize(512, "2026-01-01T00:00:00.000Z"));

    const metadata = JSON.parse(await readFile(`${timingPath}.meta.json`, "utf8"));
    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.droppedThrough).toBe("2025-12-31T23:59:59.000Z");
    expect(Number.isNaN(Date.parse(metadata.updatedAt))).toBe(false);
  });

  test("quarantines a stale dead-owner lock and enforces private modes", async () => {
    const directory = join(home, ".ashlr");
    const lockPath = `${timingPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o755 });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "abandoned",
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    await chmod(join(lockPath, "owner.json"), 0o644);

    expect(appendHookTimingBatch(timingPath, lineOfSize(512))).toBe("written");

    expect(await readFile(timingPath, "utf8")).toBe(lineOfSize(512));
    expect((await readdir(directory)).some((name) => name.includes(".stale-") || name.includes(".tmp-"))).toBe(false);
    if (process.platform !== "win32") {
      expect(await mode(directory)).toBe(0o700);
      expect(await mode(timingPath)).toBe(0o600);
    }
  });

  test("a reaper guard prevents a third writer entering during stale replacement", async () => {
    const lockPath = `${timingPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "stale-owner",
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    let replaced = false;
    let thirdResult: string | null = null;
    __setBeforeStaleQuarantineForTest((path) => {
      if (replaced) return;
      replaced = true;
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner.json"), JSON.stringify({
        token: "live-replacement",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }), { mode: 0o600 });
      thirdResult = appendHookTimingBatch(timingPath, lineOfSize(512), { lockWaitMs: 5 });
    });

    expect(appendHookTimingBatch(timingPath, lineOfSize(512), { lockWaitMs: 20 }))
      .toBe("contended");

    expect(replaced).toBe(true);
    expect(String(thirdResult)).toBe("contended");
    expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token)
      .toBe("live-replacement");
    expect((await readdir(join(home, ".ashlr"))).some((name) =>
      name.includes(".stale-") || name.includes(".reap-")))
      .toBe(false);
    await expect(readFile(timingPath)).rejects.toThrow();
  });

  test("a writer paused before lock creation yields to a newly appeared reaper", async () => {
    const reaperPath = `${timingPath}.lock.reap-test-lease`;
    let injected = false;
    __setAfterReaperPrecheckForTest(() => {
      if (injected) return;
      injected = true;
      mkdirSync(reaperPath, { recursive: true, mode: 0o700 });
      writeFileSync(join(reaperPath, "owner.json"), JSON.stringify({
        token: "active-reaper",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }), { mode: 0o600 });
    });

    expect(appendHookTimingBatch(timingPath, lineOfSize(512), { lockWaitMs: 10 }))
      .toBe("contended");

    expect(injected).toBe(true);
    expect(JSON.parse(await readFile(join(reaperPath, "owner.json"), "utf8")).token)
      .toBe("active-reaper");
    await expect(readFile(timingPath)).rejects.toThrow();
  });

  test("recovers only stale unique reaper leases and preserves live leases", async () => {
    const staleReaper = `${timingPath}.lock.reap-stale-token`;
    await mkdir(staleReaper, { recursive: true, mode: 0o700 });
    await writeFile(join(staleReaper, "owner.json"), JSON.stringify({
      token: "stale-token",
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
    }), { mode: 0o600 });

    expect(appendHookTimingBatch(timingPath, lineOfSize(512))).toBe("written");
    await expect(stat(staleReaper)).rejects.toThrow();

    await rm(timingPath, { force: true });
    const liveReaper = `${timingPath}.lock.reap-live-token`;
    await mkdir(liveReaper, { recursive: true, mode: 0o700 });
    await writeFile(join(liveReaper, "owner.json"), JSON.stringify({
      token: "live-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });

    expect(appendHookTimingBatch(timingPath, lineOfSize(512), { lockWaitMs: 10 }))
      .toBe("contended");
    expect(JSON.parse(await readFile(join(liveReaper, "owner.json"), "utf8")).token)
      .toBe("live-token");
    await expect(readFile(timingPath)).rejects.toThrow();
  });

  test("recovers future/invalid metadata and stale live-PID locks after a hard lease", async () => {
    const lockPath = `${timingPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "reused-pid",
      pid: process.pid,
      createdAt: "2999-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, old, old);

    expect(appendHookTimingBatch(timingPath, lineOfSize(512))).toBe("written");
    expect(await readFile(timingPath, "utf8")).toBe(lineOfSize(512));

    await rm(timingPath, { force: true });
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), "not-json", { mode: 0o600 });
    await utimes(lockPath, old, old);
    expect(appendHookTimingBatch(timingPath, lineOfSize(512))).toBe("written");
  });

  test("bounds record fields and exposes exactly the private timing schema", async () => {
    const secret = "SECRET-SHOULD-NOT-LEAK";
    const code = `
      import { flushHookTimings, recordHookTiming } from ${JSON.stringify(join(ROOT, "hooks", "pretooluse-common.ts"))};
      recordHookTiming({
        hook: "🔥".repeat(2000), tool: "工具".repeat(2000),
        durationMs: Number.NaN, outcome: "not-an-outcome", secret: ${JSON.stringify(secret)}
      });
      await flushHookTimings();
    `;
    const child = spawn({
      cmd: ["bun", "-e", code],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    expect(await child.exited).toBe(0);

    const raw = await readFile(timingPath, "utf8");
    const row = JSON.parse(raw.trim());
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);
    expect(Object.keys(row)).toEqual(["ts", "hook", "tool", "durationMs", "outcome"]);
    expect(Buffer.byteLength(row.hook)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(row.tool)).toBeLessThanOrEqual(512);
    expect(row.durationMs).toBe(0);
    expect(row.outcome).toBe("error");
    expect(raw).not.toContain(secret);
  });

  test("bounds lock wait and never steals an old lock from a live owner", async () => {
    const lockPath = `${timingPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "still-live",
      pid: process.pid,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }), { mode: 0o600 });
    const started = Date.now();

    expect(appendHookTimingBatch(timingPath, lineOfSize(512))).toBe("contended");

    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token)
      .toBe("still-live");
    await expect(readFile(timingPath)).rejects.toThrow();
  });

  test("explicit flush retries a contended drained batch after lock release", async () => {
    const lockPath = `${timingPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "brief-owner",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const code = `
      import { flushHookTimings, recordHookTiming } from ${JSON.stringify(join(ROOT, "hooks", "pretooluse-common.ts"))};
      recordHookTiming({ hook: "contention-retry", tool: "Read", durationMs: 1, outcome: "ok" });
      await flushHookTimings();
    `;
    const child = spawn({
      cmd: ["bun", "-e", code], cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    await Bun.sleep(650);
    await rm(lockPath, { recursive: true, force: true });

    expect(await child.exited).toBe(0);
    const raw = await readFile(timingPath, "utf8");
    expect(raw).toContain("contention-retry");
    expectCompleteJsonl(Buffer.from(raw));
  }, 5_000);

  test("lock and fsync work does not block the hook safety timeout", async () => {
    const lockPath = `${timingPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "timeout-owner",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const code = `
      import { flushHookTimings, installHookTimeout, recordHookTiming } from ${JSON.stringify(join(ROOT, "hooks", "pretooluse-common.ts"))};
      installHookTimeout("writer-timeout", 100);
      for (let i = 0; i < 4000; i++) {
        recordHookTiming({ hook: "timeout-batch-" + i, tool: "Read", durationMs: i, outcome: "ok" });
      }
      await flushHookTimings();
    `;
    const started = Date.now();
    const child = spawn({
      cmd: ["bun", "-e", code], cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(800);
    expect(await stderr).toContain("hook timeout");
  }, 3_000);

  test("rejects oversized batches without throwing or creating an active file", async () => {
    const oversized = lineOfSize(1024).repeat(HOOK_TIMING_BATCH_MAX_BYTES / 1024 + 1);
    expect(() => appendHookTimingBatch(timingPath, oversized)).not.toThrow();
    await expect(readFile(timingPath)).rejects.toThrow();
  });

  test("serializes contending writers across processes without lost or partial rows", async () => {
    const children = 12;
    const rowsPerChild = 80;
    const code = `
      import { appendHookTimingBatch } from ${JSON.stringify(LEDGER_MODULE)};
      const id = process.env.CHILD_ID;
      const path = process.env.TIMING_PATH;
      for (let i = 0; i < ${rowsPerChild}; i++) {
        const batch = JSON.stringify({
          ts: new Date().toISOString(), hook: "child-" + id, tool: "Read",
          durationMs: i, outcome: "ok"
        }) + "\\n";
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = appendHookTimingBatch(path, batch);
          if (result === "written" || result === "failed") break;
          await Bun.sleep(5);
        }
      }
    `;
    const processes = Array.from({ length: children }, (_, index) => spawn({
      cmd: ["bun", "-e", code],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CHILD_ID: String(index), TIMING_PATH: timingPath },
    }));
    const exits = await Promise.all(processes.map((child) => child.exited));
    expect(exits).toEqual(Array(children).fill(0));

    const raw = await readFile(timingPath);
    expectCompleteJsonl(raw);
    const rows = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(children * rowsPerChild);
    expect(new Set(rows.map((row) => `${row.hook}:${row.durationMs}`)).size)
      .toBe(children * rowsPerChild);
  }, 20_000);
});
