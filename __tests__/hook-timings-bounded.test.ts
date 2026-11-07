import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "bun";
import { timingBudgetMs } from "../scripts/timing-budget.ts";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
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
  __acquireLockForTest,
  __lockCreateFactForTest,
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

  test("streams 500k small rows under a 180 MiB comparable footprint", async () => {
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
      let peakFootprint = 0;
      appendHookTimingBatch(
        process.env.TIMING_PATH,
        ${JSON.stringify(lineOfSize(512, "2026-01-01T00:00:00.000Z"))},
        { onMigrationMemorySample: (bytes) => { peakFootprint = Math.max(peakFootprint, bytes); } },
      );
      const measured = process.resourceUsage().maxRSS;
      const peakRss = measured < 1_000_000 ? measured * 1024 : measured;
      console.log(JSON.stringify({ peakFootprint, peakRss }));
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
    const { peakFootprint, peakRss } = JSON.parse(await stdout) as {
      peakFootprint: number;
      peakRss: number;
    };

    expect(peakFootprint).toBeGreaterThan(0);
    expect(peakFootprint).toBeLessThan(180 * 1024 * 1024);
    expect(peakRss).toBeLessThan(512 * 1024 * 1024);
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

    // 800ms locally (bun spawn + 100ms hook timeout); scaled on CI runners.
    expect(elapsed).toBeLessThan(timingBudgetMs(800));
    expect(await stderr).toContain("hook timeout");
  }, timingBudgetMs(3_000));

  test("failure observers expose only static phase and errno and cannot break fail-open writes", async () => {
    const parent = join(home, "blocked-parent");
    await writeFile(parent, "private sentinel must not escape");
    const failures: { phase: string; code: string }[] = [];
    expect(appendHookTimingBatch(join(parent, "ledger"), lineOfSize(512), {
      onFailure: failure => { failures.push(failure); throw new Error("observer failure"); },
    })).toBe("failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.phase).toBe("directory");
    expect(failures[0]!.code).toMatch(/^[A-Z0-9_]{1,32}$/);
    expect(Object.keys(failures[0]!)).toEqual(["phase", "code"]);
    expect(JSON.stringify(failures)).not.toContain(parent);
    expect(await readFile(parent, "utf8")).toBe("private sentinel must not escape");
  });

  test("a hostile errno getter cannot break fail-open telemetry", () => {
    const error = Object.defineProperty(new Error("private diagnostic message"), "code", {
      get() { throw new Error("getter must remain contained"); },
    });
    __setAfterReaperPrecheckForTest(() => { throw error; });
    const failures: unknown[] = [];
    expect(appendHookTimingBatch(timingPath, lineOfSize(512), {
      onFailure: failure => { failures.push(failure); },
    })).toBe("failed");
    expect(failures).toEqual([]);
  });

  test("Windows delete-pending mkdir contention requires eventual exclusive creation", async () => {
    const path = join(home, "transient-lock");
    let attempts = 0;
    let tick = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => tick++);
    let result: ReturnType<typeof __acquireLockForTest>;
    try {
      result = __acquireLockForTest(path, 100, { platform: "win32", mkdir: name => {
        if (++attempts <= 2) throw Object.assign(new Error("synthetic delete-pending"), { code: "EPERM" });
        mkdirSync(name, { mode: 0o700 });
      } });
    } finally { clock.mockRestore(); }
    expect(result.result).toBe("written");
    expect(attempts).toBe(3);
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(result.owner);
    expect(result.owner!.pid).toBe(process.pid);
    expect(await readdir(path)).toEqual(["owner.json"]);
  });

  test("permanent Windows mkdir denial stays bounded and never acquires or mutates a foreign owner", async () => {
    const path = join(home, "live-lock");
    await mkdir(path);
    const owner = JSON.stringify({ token: "foreign-live-sentinel", pid: process.pid, createdAt: new Date().toISOString() });
    await writeFile(join(path, "owner.json"), owner);
    let attempts = 0;
    let tick = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => tick++);
    let denied: ReturnType<typeof __acquireLockForTest>;
    try {
      denied = __acquireLockForTest(path, 10, { platform: "win32", mkdir: () => {
        attempts++;
        throw Object.assign(new Error("synthetic permission denial"), { code: "EPERM" });
      } });
    } finally { clock.mockRestore(); }
    expect(denied).toEqual({ owner: null, result: "contended" });
    expect(attempts).toBeGreaterThan(1);
    expect(tick).toBeLessThan(1_030);
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(owner);
    expect(await readdir(home)).toEqual(["live-lock"]);
  });

  test("POSIX mkdir denial and post-create owner failure never enter Windows contention retry", async () => {
    let attempts = 0;
    const denied = __acquireLockForTest(join(home, "posix-lock"), 100, { platform: "linux", mkdir: () => {
      attempts++;
      throw Object.assign(new Error("synthetic permission denial"), { code: "EPERM" });
    } });
    expect(denied).toEqual({ owner: null, result: "failed" });
    expect(attempts).toBe(1);
    const path = join(home, "not-a-directory");
    attempts = 0;
    const broken = __acquireLockForTest(path, 100, { platform: "win32", mkdir: name => {
      attempts++;
      writeFileSync(name, "synthetic post-create failure");
    } });
    expect(broken).toEqual({ owner: null, result: "failed" });
    expect(attempts).toBe(1);
    await expect(stat(path)).rejects.toThrow();
  });

  test("lock-create observations expose static existence and liveness facts only", async () => {
    const path = join(home, "observed-lock");
    expect(__lockCreateFactForTest(path)).toBe("absent");
    await writeFile(path, "foreign bytes");
    expect(__lockCreateFactForTest(path)).toBe("foreign-leaf");
    await rm(path);
    await mkdir(path);
    expect(__lockCreateFactForTest(path)).toBe("directory-no-owner");
    await writeFile(join(path, "owner.json"), JSON.stringify({ token: "synthetic-owner", pid: process.pid, createdAt: new Date().toISOString() }));
    expect(__lockCreateFactForTest(path)).toBe("directory-live-owner");
    await writeFile(join(path, "owner.json"), JSON.stringify({ token: "synthetic-owner", pid: 2147483647, createdAt: new Date().toISOString() }));
    expect(__lockCreateFactForTest(path)).toBe("directory-dead-owner");
    await writeFile(join(path, "owner.json"), "x".repeat(4097));
    expect(__lockCreateFactForTest(path)).toBe("directory-no-owner");
  });

  test("lock acquisition failures retain bounded phase/errno diagnostics", () => {
    const failures: { phase: string; code: string }[] = [];
    expect(appendHookTimingBatch(join(home, "x".repeat(300)), lineOfSize(512), {
      onFailure: failure => { failures.push(failure); },
    })).toBe("failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.phase).toBe("lock-create");
    expect(failures[0]!.code).toMatch(/^[A-Z0-9_]{1,32}$/);
  });

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
      const progress = { id, written: 0, contended: 0, appendMs: 0 };
      console.log(JSON.stringify(progress));
      for (let i = 0; i < ${rowsPerChild}; i++) {
        const batch = JSON.stringify({
          ts: new Date().toISOString(), hook: "child-" + id, tool: "Read",
          durationMs: i, outcome: "ok"
        }) + "\\n";
        // The ledger gives up after its own 500 ms lock wait and reports busy.
        // Twelve cold bun processes on a loaded runner can see that more than 5
        // times in a row (ashlr-plugin PR 186 CI, 7.4 s, fewer rows than
        // written), so retry for much longer; the assertion below still demands
        // every accepted row, complete and unique.
        let written = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const started = performance.now();
          let failure;
          const result = appendHookTimingBatch(path, batch, { onFailure: value => { failure = value; console.error("HOOK_LEDGER_FAILURE " + JSON.stringify(value)); } });
          progress.appendMs += performance.now() - started;
          if (result === "written") { progress.written++; written = true; break; }
          if (result === "failed") throw new Error("ledger write failed: " + JSON.stringify({ ...progress, failure }));
          progress.contended++;
          await Bun.sleep(5);
        }
        if (!written) throw new Error("ledger retry exhaustion: " + JSON.stringify(progress));
        if ((i + 1) % 8 === 0) console.log(JSON.stringify(progress));
      }
    `;
    const workloadStarted = performance.now();
    const processes = Array.from({ length: children }, (_, index) => spawn({
      cmd: ["bun", "-e", code],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CHILD_ID: String(index), TIMING_PATH: timingPath },
    }));
    // Drain bounded synthetic progress concurrently. A deadline failure must
    // identify lock/append progress and reap its owned processes, rather than
    // leave writers running after Bun's enclosing timeout.
    const progress = processes.map(() => "");
    const stderr = processes.map(() => "");
    const firstOutputMs: (number | null)[] = processes.map(() => null);
    const drain = async (stream: ReadableStream<Uint8Array>, output: string[], index: number) => {
      const reader = stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          if (firstOutputMs[index] === null) firstOutputMs[index] = Math.round(performance.now() - workloadStarted);
          bytes += value.byteLength;
          if (bytes > 8192) { await reader.cancel(); return "output exceeded bound"; }
          output[index] += decoder.decode(value, { stream: true });
        }
        output[index] += decoder.decode();
        return "";
      } catch { return "progress read failed"; }
      finally { reader.releaseLock(); }
    };
    const observations = processes.map(async (child, index) => {
      const errors = await Promise.all([drain(child.stdout, progress, index), drain(child.stderr, stderr, index)]);
      const failures = stderr[index].split(/\r?\n/).filter(line => line.startsWith("HOOK_LEDGER_FAILURE ")).flatMap(line => {
        try {
          const failure = JSON.parse(line.slice("HOOK_LEDGER_FAILURE ".length));
          return Object.keys(failure).length === 2 && ["validate", "directory", "lock", "lock-create", "lock-create-absent", "lock-create-foreign-leaf", "lock-create-changing-name", "lock-create-directory-no-owner", "lock-create-directory-live-owner", "lock-create-directory-dead-owner", "lock-create-unknown", "lock-mode", "lock-owner-create", "lock-owner-write", "lock-owner-fsync", "lock-owner-close", "lock-owner-temp-mode", "lock-owner-rename", "lock-owner-final-mode", "lock-owner-directory-fsync", "inspect", "append", "migration"].includes(failure.phase) &&
            typeof failure.code === "string" && /^[A-Z0-9_]{1,32}$/.test(failure.code) ? [{ phase: failure.phase, code: failure.code }] : [];
        } catch { return []; }
      });
      return { code: await child.exited, errors: errors.filter(Boolean), failures, stderr: stderr[index].slice(-512) };
    });
    const observeProgress = (phase: "deadline" | "completed") => {
      const latest = progress.map((text, index) => {
        try {
          const row = JSON.parse(text.trim().split("\n").at(-1) ?? "null");
          if (!row || !Number.isInteger(row.written) || row.written < 0 || row.written > rowsPerChild ||
              !Number.isInteger(row.contended) || row.contended < 0 || row.contended > 16000 ||
              !Number.isFinite(row.appendMs) || row.appendMs < 0) return { index, firstOutputMs: firstOutputMs[index], progress: false };
          return { index, firstOutputMs: firstOutputMs[index], written: row.written, contended: row.contended, appendMs: Math.round(row.appendMs) };
        } catch { return { index, firstOutputMs: firstOutputMs[index], progress: false }; }
      });
      let rows: number | null = null;
      try {
        if (statSync(timingPath).size <= HOOK_TIMING_FILE_MAX_BYTES) {
          rows = readFileSync(timingPath).reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
        }
      } catch { /* Metadata cannot change the workload result. */ }
      console.error("HOOK_LEDGER_PROGRESS " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - workloadStarted),
        rows, lockFact: __lockCreateFactForTest(`${timingPath}.lock`), latest }));
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let exits: number[];
    try {
      const results = await Promise.race([
        Promise.all(observations),
        new Promise<never>((_, reject) => {
          let lastProgress = progress.join("\n");
          let lastProgressAt = performance.now();
          timer = setInterval(() => {
            const now = performance.now();
            const current = progress.join("\n");
            if (current !== lastProgress) { lastProgress = current; lastProgressAt = now; }
            if (now - lastProgressAt < 20_000 && now - workloadStarted < 120_000) return;
            observeProgress("deadline");
            const latest = progress.map(text => text.trim().split("\n").at(-1)?.slice(0, 512));
            reject(new Error("owned ledger writers stalled or exceeded deadline; last progress=" + JSON.stringify(latest)));
          }, 1_000);
        }),
      ]);
      observeProgress("completed");
      for (const result of results) for (const failure of result.failures) console.error("HOOK_LEDGER_FAILURE " + JSON.stringify(failure));
      if (results.some(result => result.code !== 0 || result.errors.length)) console.error("LEDGER_WRITER_FAILURE " + JSON.stringify(results));
      expect(results.every(result => result.errors.length === 0)).toBe(true);
      exits = results.map(result => result.code);
    } finally {
      clearInterval(timer);
      for (const child of processes) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.race([Promise.allSettled(processes.map(child => child.exited)), Bun.sleep(500)]);
    }
    expect(exits).toEqual(Array(children).fill(0));

    const raw = await readFile(timingPath);
    expectCompleteJsonl(raw);
    const rows = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(children * rowsPerChild);
    expect(new Set(rows.map((row) => `${row.hook}:${row.durationMs}`)).size)
      .toBe(children * rowsPerChild);
  }, 130_000);
});
